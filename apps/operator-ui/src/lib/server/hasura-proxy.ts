// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { readBoundedBody, waitForCoreAbort } from '@citrineos/base';
import { getOperationAST, parse } from 'graphql';
import { operatorCoreConfig, operatorRequestGuard } from './core-proxy';
import type { OperatorProxyConfig, OperatorProxySession } from './core-proxy';

export interface OperatorHasuraConfig extends OperatorProxyConfig {
  endpoint: string;
  adminSecret: string;
  role: 'user';
}

function failure(status: number): Response {
  return Response.json(
    { errors: [{ message: 'Operator GraphQL request rejected' }] },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export function operatorHasuraConfig(env: NodeJS.ProcessEnv): OperatorHasuraConfig {
  const config = operatorCoreConfig(env);
  const endpoint = new URL(env.OPERATOR_HASURA_URL ?? '');
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/v1/graphql' ||
    !env.HASURA_ADMIN_SECRET?.trim() ||
    env.OPERATOR_HASURA_ROLE !== 'user'
  )
    throw new Error('Operator GraphQL transport is not configured');
  return { ...config, endpoint: endpoint.href, adminSecret: env.HASURA_ADMIN_SECRET, role: 'user' };
}

export async function proxyOperatorHasura(
  request: Request,
  session: OperatorProxySession | null,
  config: OperatorHasuraConfig,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const rejection = operatorRequestGuard(request, session, config);
  if (rejection) return rejection;
  if (!session?.user?.roles?.includes('admin')) return failure(403);
  const incoming = new URL(request.url);
  if (request.method !== 'POST' || incoming.pathname !== '/api/graphql' || incoming.search) {
    return failure(403);
  }
  if (Array.from(request.headers.keys()).some((key) => key.startsWith('x-hasura-'))) {
    return failure(400);
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    return failure(415);
  }
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const raw = await readBoundedBody(request, 262144, controller.signal);
    const payload: unknown = JSON.parse(raw);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
      return failure(400);
    if (
      !('query' in payload) ||
      typeof payload.query !== 'string' ||
      Object.keys(payload).some((key) => !['query', 'variables', 'operationName'].includes(key))
    ) {
      return failure(400);
    }
    const operationName = 'operationName' in payload ? payload.operationName : undefined;
    if (operationName !== undefined && operationName !== null && typeof operationName !== 'string')
      return failure(400);
    const operation = getOperationAST(parse(payload.query), operationName);
    if (!operation || operation.operation === 'subscription') return failure(400);
    controller.signal.throwIfAborted();
    if (Date.now() - started >= config.timeoutMs) return failure(502);
    const upstream = await waitForCoreAbort(
      fetcher(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-hasura-admin-secret': config.adminSecret,
          'x-hasura-role': config.role,
          'x-hasura-tenant-id': String(config.tenantId),
        },
        body: raw,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      }),
      controller.signal,
    );
    const body = await readBoundedBody(upstream, 1048576, controller.signal);
    controller.signal.throwIfAborted();
    if (Date.now() - started >= config.timeoutMs) return failure(502);
    if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('application/json'))
      return failure(502);
    const result: unknown = JSON.parse(body);
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      'errors' in result ||
      !('data' in result)
    )
      return failure(502);
    const safeBody = JSON.stringify({ data: result.data });
    if (safeBody.includes(JSON.stringify(config.adminSecret).slice(1, -1))) return failure(502);
    return new Response(safeBody, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return failure(502);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
