// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { GetPublicKeyOrSecret, JwtPayload } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import type { Context, Next } from 'koa';

export interface OIDCConfig {
  jwksUri: string;
  issuer: string;
  audience: string;
  allowedSubjects: string[];
  cacheTime?: number;
  rateLimit?: boolean;
}

export function oidcAuthMiddleware(config: OIDCConfig) {
  const client = jwksClient({
    jwksUri: config.jwksUri,
    cache: true,
    cacheMaxAge: config.cacheTime || 60 * 60 * 1000,
    rateLimit: config.rateLimit ?? true,
    jwksRequestsPerMinute: 5,
  });

  const getKey: GetPublicKeyOrSecret = (header, callback) => {
    client.getSigningKey(header.kid, function (err, key) {
      if (err || !key) {
        callback(err || new Error('Signing key not found'));
      } else {
        callback(null, key.getPublicKey());
      }
    });
  };

  return async (ctx: Context, next: Next) => {
    const authHeader = ctx.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      ctx.status = 401;
      ctx.body = { error: 'Missing or invalid Authorization header' };
      return;
    }
    const token = authHeader.slice(7);
    try {
      const decoded = await new Promise<JwtPayload>((resolve, reject) => {
        jwt.verify(
          token,
          getKey,
          {
            issuer: config.issuer,
            audience: config.audience,
            algorithms: ['RS256'],
          },
          (err, payload) => {
            if (err) reject(err);
            else if (payload && typeof payload === 'object') resolve(payload);
            else reject(new Error('Invalid token payload'));
          },
        );
      });
      if (!decoded.sub || !config.allowedSubjects.includes(decoded.sub)) {
        ctx.status = 401;
        ctx.body = { error: 'Invalid token' };
        return;
      }
      ctx.state.user = decoded;
      await next();
    } catch {
      ctx.status = 401;
      ctx.body = {
        error: 'Invalid token',
      };
    }
  };
}
