// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OidcTokenProvider } from '../../authorization/OidcTokenProvider.js';
const cfg = {
  tokenUrl: 'http://iam.test/token',
  clientId: 'fixture',
  clientSecret: 'fixture-secret',
  audience: 'adapter',
};
const success = (token = 'valid-oauth') => ({
  ok: true,
  json: async () => ({ access_token: token, expires_in: 600 }),
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(success());
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
describe('OIDC provider-owned transport deadline', () => {
  it('preserves completed-token caching without changing its request semantics', async () => {
    const p = new OidcTokenProvider(cfg);
    expect(await p.getToken()).toBe('valid-oauth');
    expect(await p.getToken()).toBe('valid-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
  it('bounds a hung fetch and does not cache its late response', async () => {
    const timer = shortOwner();
    let finish!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toMatchObject({ name: 'TimeoutError' });
    finish(success('late-oauth'));
    await new Promise((r) => setTimeout(r, 10));
    fetchMock.mockResolvedValueOnce(success('fresh-oauth'));
    expect(await p.getToken()).toBe('fresh-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenCalledTimes(2);
  });
  it('uses one owner signal across headers and a stalled success body, never caching after expiry', async () => {
    const timer = shortOwner();
    let finish!: (v: unknown) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise((r) => {
          finish = r;
        }),
    });
    const p = new OidcTokenProvider(cfg);
    await expect(p.getToken()).rejects.toMatchObject({ name: 'TimeoutError' });
    finish({ access_token: 'late-body-oauth', expires_in: 600 });
    await new Promise((r) => setTimeout(r, 10));
    fetchMock.mockResolvedValueOnce(success('fresh-body-oauth'));
    expect(await p.getToken()).toBe('fresh-body-oauth');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenCalledTimes(2);
  });
  it('bounds a stalled error body under that same owner deadline', async () => {
    const timer = shortOwner();
    fetchMock.mockResolvedValueOnce({ ok: false, text: () => new Promise(() => undefined) });
    await expect(new OidcTokenProvider(cfg).getToken()).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(timer).toHaveBeenCalledTimes(1);
  });
});
