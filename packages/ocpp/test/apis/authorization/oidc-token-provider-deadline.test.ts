// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcTokenProvider } from '@/apis/authorization/oidc-token-provider.js';
import { createTestContainer } from '@test/test-container.js';
const cfg = {
  tokenUrl: 'http://iam.test/token?private-query=secret',
  clientId: 'fixture',
  clientSecret: 'fixture-secret',
  audience: 'adapter',
};
const success = (token = 'valid-opaque-oauth') =>
  Response.json({ access_token: token, expires_in: 600 });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => success());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const shortOwner = () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    expect(ms).toBe(8000);
    return timeout(40);
  });
};
function stalledBody(status = 200) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status });
  return { response, cancel };
}

describe('OIDC provider-owned transport deadline', () => {
  it('preserves opaque-token caching and form request semantics without following redirects', async () => {
    const p = new OidcTokenProvider(cfg);
    expect(await p.getToken()).toBe('valid-opaque-oauth');
    expect(await p.getToken()).toBe('valid-opaque-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(cfg.tokenUrl);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.method).toBe('POST');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(String(options?.body)).toBe(
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        audience: cfg.audience,
      }).toString(),
    );
  });

  it('bounds a hung fetch, cancels a late response and does not cache it', async () => {
    const timer = shortOwner();
    let finish: (response: Response) => void = () => {
      throw new Error('fetch not started');
    };
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'OIDC transport deadline exceeded',
    });
    const late = stalledBody();
    finish(late.response);
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce());
    fetchMock.mockResolvedValueOnce(success('fresh-oauth'));
    expect(await p.getToken()).toBe('fresh-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenCalledTimes(2);
  });

  it('uses the same owner deadline for a stalled success body and cancels its reader', async () => {
    const timer = shortOwner();
    const stalled = stalledBody();
    fetchMock.mockResolvedValueOnce(stalled.response);
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(stalled.cancel).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(success('fresh-body-oauth'));
    expect(await p.getToken()).toBe('fresh-body-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenCalledTimes(2);
  });

  it('cancels a stalled error body immediately without parsing it', async () => {
    const timer = shortOwner();
    const stalled = stalledBody(500);
    fetchMock.mockResolvedValueOnce(stalled.response);
    await expect(new OidcTokenProvider(cfg).getToken()).rejects.toThrow(
      'OIDC token request failed',
    );
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledTimes(1);
  });
});

describe('bounded OIDC response validation and sanitized failures', () => {
  it.each([204, 302, 401])('rejects HTTP %i without caching a token', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toThrow('OIDC token request failed');
    expect(await p.getToken()).toBe('valid-opaque-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    '{}',
    'null',
    '[]',
    '{"access_token":"", "expires_in":600}',
    '{"access_token":"   ", "expires_in":600}',
    '{"access_token":4, "expires_in":600}',
    '{"access_token":"opaque"}',
    '{"access_token":"opaque", "expires_in":"600"}',
    '{"access_token":"opaque", "expires_in":0}',
    '{"access_token":"opaque", "expires_in":-1}',
    '{"access_token":"opaque", "expires_in":1e400}',
    '{"access_token":"opaque", "expires_in":1e308}',
    'private-invalid-json',
  ])('rejects malformed response %s and allows a fresh request', async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(body));
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toThrow('OIDC token request failed');
    expect(await p.getToken()).toBe('valid-opaque-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the one-minute cache margin for short positive lifetimes', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ access_token: 'short-opaque', expires_in: 30 }),
    );
    const p = new OidcTokenProvider(cfg);
    expect(await p.getToken()).toBe('short-opaque');
    expect(await p.getToken()).toBe('valid-opaque-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts exactly 64 KiB split across streamed chunks', async () => {
    const body = JSON.stringify({ access_token: 'opaque', expires_in: 600, padding: '' });
    const padded = body.replace('"padding":""', `"padding":"${'x'.repeat(65_536 - body.length)}"`);
    const bytes = new TextEncoder().encode(padded);
    expect(bytes.byteLength).toBe(65_536);
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 32_768));
            controller.enqueue(bytes.subarray(32_768));
            controller.close();
          },
        }),
      ),
    );
    expect(await new OidcTokenProvider(cfg).getToken()).toBe('opaque');
  });

  it('rejects an oversized streamed response and cancels before waiting for EOF', async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(32_768));
            controller.enqueue(new Uint8Array(32_769));
          },
          cancel,
        }),
      ),
    );
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toThrow('OIDC token request failed');
    expect(cancel).toHaveBeenCalledOnce();
    expect(await p.getToken()).toBe('valid-opaque-oauth');
  });

  it.each(['http', 'network', 'stream'])('sanitizes %s logs and errors', async (failure) => {
    const { logger } = createTestContainer();
    const secret = 'private-endpoint-body fixture-secret private-query secret-token';
    if (failure === 'http')
      fetchMock.mockResolvedValueOnce(
        new Response(secret, { status: 500, statusText: 'secret-status' }),
      );
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error(secret));
    if (failure === 'stream')
      fetchMock.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(secret));
            },
          }),
        ),
      );
    const p = new OidcTokenProvider(cfg, logger);
    await expect(p.getToken()).rejects.toThrow(/^OIDC token request failed$/);
    const logs = JSON.stringify([...logger.debug.mock.calls, ...logger.error.mock.calls]);
    expect(logs).toContain('OIDC token request failed');
    for (const value of [
      'fixture-secret',
      'private-query',
      'secret-token',
      'secret-status',
      'private-endpoint-body',
      cfg.tokenUrl,
    ]) {
      expect(logs).not.toContain(value);
    }
    expect(await p.getToken()).toBe('valid-opaque-oauth');
  });
});
