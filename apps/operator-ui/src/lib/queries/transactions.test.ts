// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { Kind } from 'graphql';
import { TRANSACTION_GET_QUERY } from './transactions';

describe('transaction detail tariff contract', () => {
  it('loads the locked tariff directly from the transaction', () => {
    const operation = TRANSACTION_GET_QUERY.definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    const transaction = operation?.selectionSet.selections.find(
      (selection) => selection.kind === Kind.FIELD && selection.name.value === 'Transactions',
    );
    if (transaction?.kind !== Kind.FIELD) throw new Error('Transaction selection missing');
    const tariff = transaction.selectionSet?.selections.find(
      (selection) => selection.kind === Kind.FIELD && selection.name.value === 'Tariff',
    );
    if (tariff?.kind !== Kind.FIELD) throw new Error('Locked tariff relationship missing');
    expect(tariff.alias?.value).toBe('tariff');
    expect(
      tariff.selectionSet?.selections.flatMap((selection) =>
        selection.kind === Kind.FIELD ? [selection.name.value] : [],
      ),
    ).toEqual(['id', 'currency', 'pricePerKwh']);
  });
});
