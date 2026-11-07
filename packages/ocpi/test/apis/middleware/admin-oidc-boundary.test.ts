// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import Koa from 'koa';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { oidcAuthMiddleware } from '@ocpi/apis/middleware/oidc-auth-middleware.js';

const keys = vi.hoisted(() => ({ publicKey: '' }));
vi.mock('jwks-rsa', () => ({
  default: () => ({
    getSigningKey: (
      _kid: string,
      callback: (error: Error | null, key: { getPublicKey: () => string }) => void,
    ) => callback(null, { getPublicKey: () => keys.publicKey }),
  }),
}));
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
keys.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const config = {
  jwksUri: 'https://issuer.test/jwks',
  issuer: 'https://issuer.test',
  audience: 'ocpi-admin',
  allowedSubjects: ['trusted-admin'],
};

function context(token: string) {
  const request = new IncomingMessage(new Socket());
  request.headers.authorization = `Bearer ${token}`;
  return new Koa().createContext(request, new ServerResponse(request));
}

describe('administrative verified issuer, audience and subject fence', () => {
  it.each([
    { iss: 'https://other.test' },
    { iss: undefined },
    { aud: 'core' },
    { aud: undefined },
    { sub: 'tenant-self-service' },
    { sub: '' },
    { sub: undefined },
    { exp: 1 },
  ])('rejects trusted-key tokens with wrong claims %j', async (claims) => {
    const token = jwt.sign(
      {
        iss: config.issuer,
        aud: config.audience,
        sub: 'trusted-admin',
        exp: Math.floor(Date.now() / 1000) + 60,
        ...claims,
      },
      pair.privateKey,
      { algorithm: 'RS256', keyid: 'test' },
    );
    const ctx = context(token);
    const next = vi.fn();
    await oidcAuthMiddleware(config)(ctx, next);
    expect(ctx.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.body).toEqual({ error: 'Invalid token' });
  });

  it('allows only the explicitly listed subject after cryptographic verification', async () => {
    const token = jwt.sign(
      { iss: config.issuer, aud: config.audience, sub: 'trusted-admin' },
      pair.privateKey,
      { algorithm: 'RS256', expiresIn: 60, keyid: 'test' },
    );
    const ctx = context(token);
    const next = vi.fn();
    await oidcAuthMiddleware(config)(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
