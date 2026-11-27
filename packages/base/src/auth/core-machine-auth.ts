// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';

export interface CoreMachineAuthSettings {
  tokenUrl: string;
  coreUrl: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  audience: 'citrineos-core';
  role: 'evyar-ocpi' | 'evyar-operator';
  scope: 'citrineos:ocpi:invoke' | 'citrineos:operator:invoke';
  timeoutMs?: number;
  expiryMarginSeconds?: number;
}

export interface CoreMachineResponse {
  status: number;
  contentType: string;
  body: string;
}

interface CachedToken {
  value: string;
  usableUntil: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validCoreTenant(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function configuredUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error();
    return url;
  } catch {
    throw new Error('Invalid Core machine endpoint configuration');
  }
}

export function waitForCoreAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    signal.throwIfAborted();
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error('Core machine deadline exceeded'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function checkDeadline(signal: AbortSignal, started: number, timeoutMs: number): void {
  signal.throwIfAborted();
  if (Date.now() - started >= timeoutMs) throw new Error('Core machine deadline exceeded');
}

export async function readBoundedBody(
  response: Pick<Response, 'headers' | 'body'>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new Error('Core response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await waitForCoreAbort(reader.read(), signal);
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Core response is too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Checks the issuer's resource binding; Core independently verifies signature and JWKS. */
export function coreMachineTokenExpiry(
  token: string,
  settings: CoreMachineAuthSettings,
  tenantId: number,
  now: number,
): number {
  try {
    if (token.length > 32768) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error();
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (
      !record(header) ||
      !record(claims) ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      typeof header.alg !== 'string' ||
      !/^(RS|PS|ES)(256|384|512)$/.test(header.alg)
    )
      throw new Error();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const tenant = claims.core_tenant_id;
    if (
      claims.iss !== settings.issuer ||
      audiences.length !== 1 ||
      audiences[0] !== settings.audience ||
      typeof claims.sub !== 'string' ||
      claims.sub !== settings.clientId ||
      claims.actor_type !== 'service' ||
      !(
        (validCoreTenant(tenant) || (typeof tenant === 'string' && /^[1-9][0-9]*$/.test(tenant))) &&
        String(tenant) === String(tenantId)
      ) ||
      !Array.isArray(claims.core_roles) ||
      claims.core_roles.length !== 1 ||
      claims.core_roles[0] !== settings.role ||
      !Array.isArray(claims.scopes) ||
      claims.scopes.length !== 1 ||
      claims.scopes[0] !== settings.scope ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf * 1000 > now))
    )
      throw new Error();
    return claims.exp * 1000;
  } catch {
    throw new Error('Core machine token resource binding is invalid');
  }
}

export class CoreMachineTokenProvider {
  private readonly settings: Readonly<CoreMachineAuthSettings>;
  private readonly tokens = new Map<number, CachedToken>();
  private readonly pending = new Map<number, Promise<string>>();
  private readonly timeoutMs: number;
  private readonly marginMs: number;
  private readonly origin: string;

  constructor(
    settings: CoreMachineAuthSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.settings = Object.freeze({ ...settings });
    this.origin = configuredUrl(settings.coreUrl).origin;
    configuredUrl(settings.tokenUrl);
    this.timeoutMs = settings.timeoutMs ?? 5000;
    this.marginMs = (settings.expiryMarginSeconds ?? 30) * 1000;
    if (
      !settings.clientId ||
      !settings.clientSecret ||
      !settings.issuer ||
      settings.audience !== 'citrineos-core' ||
      !(
        (settings.role === 'evyar-ocpi' && settings.scope === 'citrineos:ocpi:invoke') ||
        (settings.role === 'evyar-operator' && settings.scope === 'citrineos:operator:invoke')
      ) ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30000 ||
      !Number.isFinite(this.marginMs) ||
      this.marginMs < 0 ||
      this.marginMs > 300000
    ) {
      throw new Error('Invalid Core machine authentication configuration');
    }
  }

  async token(tenantId: number, rejectedToken?: string): Promise<string> {
    if (!validCoreTenant(tenantId)) throw new Error('Invalid Core machine tenant');
    const cached = this.tokens.get(tenantId);
    if (cached && cached.value !== rejectedToken && cached.usableUntil > Date.now())
      return cached.value;
    if (cached) this.tokens.delete(tenantId);
    const inFlight = this.pending.get(tenantId);
    if (inFlight) return inFlight;
    if (this.pending.size >= 256) throw new Error('Core machine authentication capacity exceeded');
    const work = this.acquire(tenantId);
    this.pending.set(tenantId, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(tenantId) === work) this.pending.delete(tenantId);
    }
  }

  private async acquire(tenantId: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const response = await waitForCoreAbort(
        this.fetcher(this.settings.tokenUrl, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grantType: 'client_credentials',
            clientId: this.settings.clientId,
            clientSecret: this.settings.clientSecret,
            scope: this.settings.scope,
            audience: this.settings.audience,
            coreTenantId: tenantId,
          }),
        }),
        controller.signal,
      );
      checkDeadline(controller.signal, started, this.timeoutMs);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error();
      }
      const body: unknown = JSON.parse(await readBoundedBody(response, 65536, controller.signal));
      checkDeadline(controller.signal, started, this.timeoutMs);
      if (
        !record(body) ||
        typeof body.access_token !== 'string' ||
        typeof body.token_type !== 'string' ||
        body.token_type.toLowerCase() !== 'bearer' ||
        typeof body.expires_in !== 'number' ||
        !Number.isFinite(body.expires_in) ||
        body.expires_in <= 0
      )
        throw new Error();
      const now = Date.now();
      const expiry = coreMachineTokenExpiry(body.access_token, this.settings, tenantId, now);
      const usableUntil = Math.min(expiry, started + body.expires_in * 1000) - this.marginMs;
      checkDeadline(controller.signal, started, this.timeoutMs);
      if (usableUntil <= now) throw new Error();
      if (this.tokens.size >= 256) {
        const oldest = this.tokens.keys().next();
        if (!oldest.done) this.tokens.delete(oldest.value);
      }
      this.tokens.set(tenantId, { value: body.access_token, usableUntil });
      return body.access_token;
    } catch {
      throw new Error('Core machine authentication failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async request(
    tenantId: number,
    url: URL,
    init: Pick<RequestInit, 'method' | 'headers'> & { body?: string; signal?: AbortSignal },
    maxResponseBytes = 1048576,
  ): Promise<CoreMachineResponse> {
    if (configuredUrl(url.href).origin !== this.origin) throw new Error('Core origin mismatch');
    const requestedTenants = url.searchParams.getAll('tenantId');
    if (requestedTenants.length !== 1 || requestedTenants[0] !== String(tenantId))
      throw new Error('Core tenant mismatch');
    const headers = new Headers(init.headers);
    if (
      [
        'authorization',
        'proxy-authorization',
        'cookie',
        'host',
        'x-api-key',
        'x-hasura-admin-secret',
      ].some((name) => headers.has(name))
    )
      throw new Error('Static Core credentials are forbidden');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) controller.abort();
    try {
      checkDeadline(controller.signal, started, this.timeoutMs);
      let token = await waitForCoreAbort(this.token(tenantId), controller.signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        checkDeadline(controller.signal, started, this.timeoutMs);
        headers.set('authorization', `Bearer ${token}`);
        const response = await waitForCoreAbort(
          this.fetcher(url, { ...init, headers, redirect: 'error', signal: controller.signal }),
          controller.signal,
        );
        checkDeadline(controller.signal, started, this.timeoutMs);
        if (response.status === 401 && attempt === 0) {
          void response.body?.cancel().catch(() => undefined);
          token = await waitForCoreAbort(this.token(tenantId, token), controller.signal);
          continue;
        }
        const body = await readBoundedBody(response, maxResponseBytes, controller.signal);
        checkDeadline(controller.signal, started, this.timeoutMs);
        return {
          status: response.status,
          contentType: response.headers.get('content-type') ?? 'application/json',
          body,
        };
      }
      throw new Error();
    } catch {
      throw new Error('Core machine request failed');
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
