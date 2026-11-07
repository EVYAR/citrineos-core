// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import type { TariffDto } from '@citrineos/types';
import { faker } from '@faker-js/faker';

export function aTariff(override?: Partial<TariffDto>): TariffDto {
  return {
    id: faker.number.int({ min: 1, max: 100000 }),
    currency: 'USD',
    pricePerKwh: faker.number.float({ min: 0, max: 5, multipleOf: 0.05 }),
    pricePerMin: null,
    pricePerSession: null,
    taxRate: 0,
    authorizationAmount: 0,
    paymentFee: 0,
    ...override,
  };
}
