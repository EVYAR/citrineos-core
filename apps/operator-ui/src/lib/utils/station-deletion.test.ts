// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { stationDeletionBlockReason } from './station-deletion';

describe('station history preservation', () => {
  it('blocks completed session history even without OCPP message history', () => {
    expect(stationDeletionBlockReason({ transactionHistory: [{ id: 7 }], ocppMessages: [] })).toBe(
      'Cannot delete a station that has session history',
    );
  });

  it('blocks missing history evidence and permits an evidenced empty station', () => {
    expect(stationDeletionBlockReason({})).toBeDefined();
    expect(
      stationDeletionBlockReason({ transactionHistory: [], ocppMessages: [{ id: 1 }] }),
    ).toBeDefined();
    expect(
      stationDeletionBlockReason({ transactionHistory: [], ocppMessages: [] }),
    ).toBeUndefined();
  });
});
