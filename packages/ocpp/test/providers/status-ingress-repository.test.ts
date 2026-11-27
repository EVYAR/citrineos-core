// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { makeStatusIngressRepository } from './status-ingress-repository.js';

describe('router receipt memory fixture (not PostgreSQL acceptance)', () => {
  it('serializes duplicate reservations and preserves identity after a rejected write', async () => {
    const repository = makeStatusIngressRepository();
    await repository.setConnection(1, 'station', 'socket', async () => true);
    const reserve = (correlation: string, status = 'Available') =>
      repository.reserve(
        1,
        'station',
        'socket',
        correlation,
        'ocpp2.0.1',
        [2, correlation, 'StatusNotification', { status }],
        new Date(0),
      );
    expect(await Promise.all([reserve('same'), reserve('same')])).toEqual([1, 1]);
    await expect(reserve('same', 'Occupied')).rejects.toThrow('STATUS_INGRESS_IDENTITY_REUSED');
    expect(await reserve('next')).toBe(2);
  });

  it('retains the current socket and receipt sequence after a rejected registration', async () => {
    const repository = makeStatusIngressRepository();
    await repository.setConnection(1, 'station', 'current', async () => true);
    await expect(
      repository.setConnection(1, 'station', 'retired', async () => false),
    ).rejects.toThrow('STATUS_INGRESS_RETIRED_REGISTRATION');
    await expect(
      repository.reserve(1, 'station', 'retired', 'call', 'ocpp2.0.1', [], new Date(0)),
    ).rejects.toThrow('STATUS_INGRESS_RETIRED_CONNECTION');
    expect(
      await repository.reserve(1, 'station', 'current', 'call', 'ocpp2.0.1', [], new Date(0)),
    ).toBe(1);
  });
});
