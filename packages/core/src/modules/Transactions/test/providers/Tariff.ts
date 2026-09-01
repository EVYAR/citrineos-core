// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { Tariff } from '@citrineos/core';
import { faker } from '@faker-js/faker';

export function aTariff(override?: Partial<Tariff>): Tariff {
  return {
    id: faker.string.uuid(),
    currency: 'USD',
    pricePerKwh: faker.number.float({ min: 0, max: 5, multipleOf: 0.05 }),
    pricePerMin: null,
    pricePerSession: null,
    taxRate: null,
    authorizationAmount: null,
    paymentFee: null,
    ...override,
  } as Tariff;
}
