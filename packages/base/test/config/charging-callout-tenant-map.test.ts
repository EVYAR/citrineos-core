// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { configSchema } from '@citrineos/types';

const settings = {
  enabled: true,
  adapterBaseUrl: 'http://adapter.test',
  webhookToken: 'test'.repeat(8),
  fenceSeconds: 30,
  declineRetryBaseMs: 1000,
  declineRetryMaxMs: 300000,
  declineMaxAttempts: 50,
  declineRequestTimeoutMs: 3000,
};

const schema = configSchema.shape.realTimeAuthChargingCallouts;

describe('charging callout tenant map', () => {
  it.each(['00000000-0000-0000-0000-000000000001', '12345678-1234-4234-8234-123456789abc'])(
    'preserves the canonical platform tenant reference %s',
    (tenant) => {
      expect(schema.parse({ ...settings, tenantMap: { '1': tenant } }).tenantMap).toEqual({
        '1': tenant,
      });
    },
  );
  it.each([
    '',
    'not-a-tenant',
    '1',
    '00000000-0000-0000-0000-00000000001',
    '00000000-0000-0000-0000-00000000000g',
    ' 00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001/suffix',
  ])('rejects a malformed tenant reference %s', (tenant) => {
    expect(schema.safeParse({ ...settings, tenantMap: { '1': tenant } }).success).toBe(false);
  });
  it('preserves distinct explicit tenant mappings', () => {
    const tenantMap = {
      '1': '00000000-0000-0000-0000-000000000001',
      '2': '12345678-1234-4234-8234-123456789abc',
    };
    expect(schema.parse({ ...settings, tenantMap }).tenantMap).toEqual(tenantMap);
  });
  it('keeps an empty tenant map without adding other tenants', () => {
    expect(schema.parse({ ...settings, tenantMap: {} }).tenantMap).toEqual({});
  });
});

it('keeps durable callouts disabled by default', () => {
  expect(configSchema.shape.realTimeAuthChargingCallouts.parse(undefined).enabled).toBe(false);
});
