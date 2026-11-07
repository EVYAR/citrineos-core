// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

export const toDateTimeLocalValue = (value?: string | null) => {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
};

export const toIsoDateTimeValue = (value: string) => {
  if (!value) return undefined;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};
