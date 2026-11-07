// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  CoreMachineTokenProvider,
  readBoundedBody,
  validCoreTenant,
  waitForCoreAbort,
} from '@citrineos/base';
import type { CoreMachineResponse } from '@citrineos/base';

const ocpp16 = [
  'configuration/changeAvailability',
  'configuration/changeConfiguration',
  'configuration/dataTransfer',
  'configuration/getConfiguration',
  'configuration/reset',
  'configuration/triggerMessage',
  'configuration/updateFirmware',
  'evdriver/remoteStartTransaction',
  'evdriver/remoteStopTransaction',
  'evdriver/unlockConnector',
  'reporting/getDiagnostics',
];
const ocpp2 = [
  'certificates/certificateSigned',
  'certificates/deleteCertificate',
  'certificates/getInstalledCertificateIds',
  'certificates/installCertificate',
  'configuration/changeAvailability',
  'configuration/dataTransfer',
  'configuration/reset',
  'configuration/setNetworkProfile',
  'configuration/triggerMessage',
  'configuration/updateFirmware',
  'evdriver/clearCache',
  'evdriver/requestStartTransaction',
  'evdriver/requestStopTransaction',
  'evdriver/unlockConnector',
  'monitoring/getVariables',
  'monitoring/setVariables',
  'reporting/customerInformation',
  'reporting/getBaseReport',
  'reporting/getLog',
  'transactions/getTransactionStatus',
];
const routes = new Set([
  'GET permissions/user',
  'POST commands/setStationPassword',
  'DELETE commands/stationNetworkProfile',
  'DELETE ocpprouter/connection',
  ...ocpp16.map((path) => `POST ocpp/1.6/${path}`),
  ...['2.0.1', '2.1'].flatMap((version) => ocpp2.map((path) => `POST ocpp/${version}/${path}`)),
]);

export interface OperatorProxySession {
  user?: { roles?: string[] };
  error?: string;
}

export interface OperatorProxyConfig {
  tenantId: number;
  publicOrigin: string;
  requestOrigin?: string;
  coreOrigin: string;
  timeoutMs: number;
}

export interface OperatorCoreTransport {
  request(
    tenantId: number,
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
    maxResponseBytes: number,
  ): Promise<CoreMachineResponse>;
}

function denied(status: number, message: string): Response {
  return Response.json(
    { statusCode: status, error: message, message },
    {
      status,
      headers: { 'cache-control': 'no-store' },
    },
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tenantMatches(value: unknown, tenantId: number): boolean {
  return (typeof value === 'number' && value === tenantId) || value === String(tenantId);
}

function bodyTenantsMatch(value: unknown, tenantId: number, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value))
    return value.every((entry: unknown) => bodyTenantsMatch(entry, tenantId, depth + 1));
  if (!object(value)) return true;
  return Object.entries(value).every(([key, entry]) =>
    key === 'tenantId'
      ? tenantMatches(entry, tenantId)
      : bodyTenantsMatch(entry, tenantId, depth + 1),
  );
}

export async function proxyOperatorCore(
  request: Request,
  path: string[],
  session: OperatorProxySession | null,
  config: OperatorProxyConfig,
  transport: OperatorCoreTransport,
): Promise<Response> {
  if (!session || session.error) return denied(401, 'Operator session required');
  if (!session.user?.roles?.some((role) => role === 'admin' || role === 'operator')) {
    return denied(403, 'Operator role required');
  }
  if (!validCoreTenant(config.tenantId)) return denied(503, 'Operator transport unavailable');
  const incoming = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (
    (incoming.origin !== config.publicOrigin && incoming.origin !== config.requestOrigin) ||
    (origin !== null && origin !== config.publicOrigin) ||
    (site !== null && site !== 'same-origin' && site !== 'none') ||
    (request.method !== 'GET' && origin !== config.publicOrigin)
  ) {
    return denied(403, 'Same-origin request required');
  }
  const pathname = path.join('/');
  if (
    !routes.has(`${request.method} ${pathname}`) ||
    path.some((part) => !part || /[%\\/?#]/.test(part))
  ) {
    return denied(403, 'Core route is not allowed');
  }
  const allowedQuery = new Set(['tenantId']);
  if (pathname.startsWith('ocpp/')) allowedQuery.add('identifier');
  if (pathname.endsWith('/configuration/setNetworkProfile'))
    allowedQuery.add('websocketServerConfigId');
  if (pathname === 'ocpprouter/connection' || pathname === 'commands/stationNetworkProfile') {
    allowedQuery.add('ocppConnectionName');
  }
  if (pathname === 'commands/stationNetworkProfile') allowedQuery.add('configurationSlot');
  for (const [key, value] of incoming.searchParams) {
    if (
      !allowedQuery.has(key) ||
      (key === 'tenantId' && !tenantMatches(value, config.tenantId)) ||
      (key === 'configurationSlot' && !/^[0-9]{1,5}$/.test(value)) ||
      value.length > 512
    )
      return denied(400, 'Invalid Core query');
  }
  for (const key of allowedQuery) {
    if (key !== 'configurationSlot' && incoming.searchParams.getAll(key).length > 1) {
      return denied(400, 'Repeated Core query parameter');
    }
  }
  if (Array.from(incoming.searchParams).length > 128) return denied(400, 'Invalid Core query');
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let body: string | undefined;
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return denied(415, 'JSON request required');
      }
      const raw = await readBoundedBody(request, 262144, controller.signal);
      controller.signal.throwIfAborted();
      if (Date.now() - started >= config.timeoutMs) throw new Error('Operator deadline exceeded');
      const payload: unknown = JSON.parse(raw);
      if (
        !object(payload) ||
        !bodyTenantsMatch(payload, config.tenantId) ||
        [
          'coreTenantId',
          'scope',
          'scopes',
          'audience',
          'roles',
          'role',
          'upstreamUrl',
          'clientSecret',
        ].some((key) => key in payload)
      )
        return denied(400, 'Invalid Core payload');
      body = JSON.stringify(
        pathname === 'commands/setStationPassword'
          ? { ...payload, tenantId: config.tenantId }
          : payload,
      );
    } else if (request.body !== null) {
      return denied(400, 'Request body is not allowed');
    }
    const target = new URL(`/${pathname}`, config.coreOrigin);
    target.search = incoming.search;
    target.searchParams.set('tenantId', String(config.tenantId));
    const result = await waitForCoreAbort(
      transport.request(
        config.tenantId,
        target,
        {
          method: request.method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: controller.signal,
        },
        1048576,
      ),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (Date.now() - started >= config.timeoutMs) throw new Error('Operator deadline exceeded');
    if (result.status < 200 || result.status >= 300)
      return denied(
        result.status >= 400 && result.status <= 599 ? result.status : 502,
        'Core request rejected',
      );
    if (result.status === 204)
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    if (!result.contentType.toLowerCase().startsWith('application/json'))
      return denied(502, 'Invalid Core response');
    return new Response(result.body, {
      status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return denied(502, 'Core transport failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function operatorCoreConfig(env: NodeJS.ProcessEnv): OperatorProxyConfig {
  const tenant = env.OPERATOR_CORE_TENANT_ID;
  const tenantId = tenant && /^[1-9][0-9]*$/.test(tenant) ? Number(tenant) : NaN;
  if (
    env.NEXT_PUBLIC_CORE_TRANSPORT !== 'server' ||
    (env.NEXT_PUBLIC_AUTH_PROVIDER ?? 'generic') !== 'generic' ||
    !validCoreTenant(tenantId) ||
    env.NEXT_PUBLIC_TENANT_ID !== String(tenantId) ||
    !env.OPERATOR_CORE_URL ||
    !env.NEXTAUTH_URL
  )
    throw new Error('Operator transport is not configured');
  const core = new URL(env.OPERATOR_CORE_URL);
  const publicUrl = new URL(env.NEXTAUTH_URL);
  if (
    ![core, publicUrl].every(
      (url) =>
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash,
    )
  ) {
    throw new Error('Operator transport origins are invalid');
  }
  const internal = env.OPERATOR_REQUEST_ORIGIN ? new URL(env.OPERATOR_REQUEST_ORIGIN) : undefined;
  if (
    internal &&
    (!['https:', 'http:'].includes(internal.protocol) ||
      internal.username ||
      internal.password ||
      internal.pathname !== '/' ||
      internal.search ||
      internal.hash)
  )
    throw new Error('Operator request origin is invalid');
  return {
    tenantId,
    coreOrigin: core.origin,
    publicOrigin: publicUrl.origin,
    requestOrigin: internal?.origin,
    timeoutMs: 10000,
  };
}

export function operatorCoreProvider(env: NodeJS.ProcessEnv): CoreMachineTokenProvider {
  return new CoreMachineTokenProvider({
    tokenUrl: env.OPERATOR_CORE_TOKEN_URL ?? '',
    coreUrl: env.OPERATOR_CORE_URL ?? '',
    clientId: env.OPERATOR_CORE_CLIENT_ID ?? '',
    clientSecret: env.OPERATOR_CORE_CLIENT_SECRET ?? '',
    issuer: env.OPERATOR_CORE_ISSUER ?? '',
    audience: 'citrineos-core',
    scope: 'citrineos:operator:invoke',
    role: 'evyar-operator',
    timeoutMs: 10000,
  });
}
