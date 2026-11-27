// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { getServerSession } from 'next-auth';
import authOptions from '@app/api/auth/[...nextauth]/options';
import {
  operatorCoreConfig,
  operatorCoreProvider,
  proxyOperatorCore,
} from '@lib/server/core-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let provider: ReturnType<typeof operatorCoreProvider> | undefined;

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.error)
    return Response.json({ error: 'Operator session required' }, { status: 401 });
  if (!session.user?.roles?.some((role) => role === 'admin' || role === 'operator')) {
    return Response.json({ error: 'Operator role required' }, { status: 403 });
  }
  try {
    const config = operatorCoreConfig(process.env);
    provider ??= operatorCoreProvider(process.env);
    return await proxyOperatorCore(request, (await context.params).path, session, config, provider);
  } catch {
    return Response.json(
      { error: 'Operator transport unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export { handle as GET, handle as POST, handle as DELETE };
