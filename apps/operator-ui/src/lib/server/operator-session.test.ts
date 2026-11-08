// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
vi.mock('@lib/utils/config', () => ({
  default: {
    authProvider: 'generic',
    adminEmail: 'operator@test.invalid',
    adminPassword: 'test-only-password',
  },
}));
import authOptions from '@app/api/auth/[...nextauth]/options';

describe('trusted generic operator session', () => {
  it('retains server-assigned roles in the signed session token without service credentials', async () => {
    const callback = authOptions.callbacks?.jwt;
    if (!callback) throw new Error('JWT callback missing');
    const token = await callback({
      token: { sub: '1' },
      user: { id: '1', name: 'Admin User', roles: ['admin'] },
      account: { provider: 'generic', type: 'credentials', providerAccountId: '1' },
      trigger: 'signIn',
      isNewUser: false,
    });
    expect(token.roles).toEqual(['admin']);
    expect(token.accessToken).toBeUndefined();
    expect(JSON.stringify(token)).not.toContain('test-only-password');
  });
});
