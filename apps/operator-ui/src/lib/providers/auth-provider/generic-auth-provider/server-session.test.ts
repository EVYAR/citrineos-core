// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession } from 'next-auth/react';
import { createGenericAuthProvider } from './index';
vi.mock('@lib/utils/config', () => ({
  default: {
    coreTransport: 'server',
    tenantId: '7',
    adminEmail: 'synthetic-operator@invalid.example',
  },
}));
vi.mock('next-auth/react', () => ({ getSession: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('@lib/utils/dev-client', () => ({
  fetchDevRoles: vi.fn(() => {
    throw Error('Dev role discovery forbidden');
  }),
  fetchDevToken: vi.fn(() => {
    throw Error('Dev token mint forbidden');
  }),
  isStaleDevSession: vi.fn(),
}));
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw Error('Browser storage cannot authorize server transport');
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Unexpected HTTP');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
describe('configured generic server transport', () => {
  it('storage-key options do not shadow application transport settings', async () => {
    const provider = createGenericAuthProvider({ tokenKey: 'alternate-key' });
    expect(await provider.getToken()).toBeUndefined();
    vi.mocked(getSession).mockResolvedValue({
      user: { sub: 'operator-id', name: 'Operator', roles: ['admin'] },
      expires: '2030-01-01T00:00:00Z',
    });
    expect(await provider.check()).toEqual({ authenticated: true });
    expect(await provider.getPermissions?.()).toEqual({ roles: ['admin'] });
    expect(await provider.getIdentity?.()).toMatchObject({ id: 'operator-id', name: 'Operator' });
  });
  it('no signed session cannot use a saved local user', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect(await createGenericAuthProvider().check()).toMatchObject({
      authenticated: false,
      redirectTo: '/login',
    });
  });
  it('a non-operator session cannot enter the operator console', async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { sub: 'driver-id', roles: ['driver'] },
      expires: '2030-01-01T00:00:00Z',
    });
    expect(await createGenericAuthProvider().check()).toMatchObject({ authenticated: false });
  });
});
