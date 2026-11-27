// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { toDateTimeLocalValue, toIsoDateTimeValue } from './date-time-local';

describe('authorization expiry input', () => {
  it('round trips an ISO expiry through local browser time', () => {
    const expiry = '2026-11-07T12:34:00.000Z';
    expect(toIsoDateTimeValue(toDateTimeLocalValue(expiry))).toBe(expiry);
  });

  it('clears an optional expiry and preserves invalid input for validation', () => {
    expect(toDateTimeLocalValue(null)).toBe('');
    expect(toIsoDateTimeValue('')).toBeUndefined();
    expect(toIsoDateTimeValue('invalid')).toBe('invalid');
  });
});
