// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { configSchema } from '@citrineos/types';

describe('ordinary RFID callback budget', () => {
  const schema = configSchema.shape.realTimeAuthRequestTimeoutMs;

  it('defaults to 8 seconds', () => {
    expect(schema.parse(undefined)).toBe(8000);
  });

  it.each([100, 10000])('accepts the supported boundary %s ms', (budget) => {
    expect(schema.parse(budget)).toBe(budget);
  });

  it.each([99, 10001, 100.5, '8000', null])('rejects unsupported budget %s', (budget) => {
    expect(schema.safeParse(budget).success).toBe(false);
  });

  it('keeps the independent decision-cache horizon at 15 seconds', () => {
    expect(configSchema.shape.timeouts.parse(undefined).realTimeAuthDefaultTimeoutSeconds).toBe(15);
  });
});
