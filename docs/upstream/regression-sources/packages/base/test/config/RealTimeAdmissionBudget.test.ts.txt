// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { systemConfigInputSchema, systemConfigSchema } from '../../src/config/types.js';
describe('ordinary RFID callback budget defaults', () => {
  it('uses8s within the existing100ms..10s supported range', () => {
    for (const schema of [
      systemConfigInputSchema.shape.realTimeAuthRequestTimeoutMs,
      systemConfigSchema.shape.realTimeAuthRequestTimeoutMs,
    ]) {
      expect(schema.parse(undefined)).toBe(8000);
      expect(schema.parse(10000)).toBe(10000);
      expect(() => schema.parse(10001)).toThrow();
      expect(() => schema.parse(99)).toThrow();
    }
  });
  it('keeps the independent15s decision-cache horizon unchanged', () =>
    expect(systemConfigSchema.shape.realTimeAuthDefaultTimeoutSeconds.parse(undefined)).toBe(15));
});
