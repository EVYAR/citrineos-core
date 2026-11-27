// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { getServerSession } from 'next-auth';
import authOptions from '@app/api/auth/[...nextauth]/options';
import { operatorHasuraConfig, proxyOperatorHasura } from '@lib/server/hasura-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session || session.error) {
      return Response.json(
        { error: 'Operator session required' },
        {
          status: 401,
          headers: { 'cache-control': 'no-store' },
        },
      );
    }
    if (!session.user?.roles?.includes('admin')) {
      return Response.json(
        { error: 'Operator admin role required' },
        {
          status: 403,
          headers: { 'cache-control': 'no-store' },
        },
      );
    }
    return await proxyOperatorHasura(request, session, operatorHasuraConfig(process.env));
  } catch {
    return Response.json(
      { error: 'Operator GraphQL transport unavailable' },
      {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      },
    );
  }
}
