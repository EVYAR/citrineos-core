// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { GET_TRANSACTION_BY_ID_QUERY } from '@ocpi/transport/graphql/queries/transaction-queries.js';

describe('GET_TRANSACTION_BY_ID_QUERY', () => {
  it('does not select through Transactions_by_pk, which needs the whole (id, createdAt) key', () => {
    expect(GET_TRANSACTION_BY_ID_QUERY).not.toMatch(/Transactions_by_pk/);
  });

  it('selects the station the session EVSE uid is built from', () => {
    expect(GET_TRANSACTION_BY_ID_QUERY).toMatch(
      /station:\s*ChargingStation\s*\{[^}]*\bocppConnectionName\b/,
    );
  });

  it('uses the complete tenant and partition identity', () => {
    expect(GET_TRANSACTION_BY_ID_QUERY).toContain('createdAt: { _eq: $createdAt }');
    expect(GET_TRANSACTION_BY_ID_QUERY).toContain('tenantId: { _eq: $tenantId }');
    expect(GET_TRANSACTION_BY_ID_QUERY).toContain('limit: 2');
  });
});
