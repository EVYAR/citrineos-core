// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

export function ocpiGraphqlHeaders(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 65536) throw new Error();
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const headers: Record<string, string> = {};
    const names = new Set<string>();
    for (const [name, header] of Object.entries(parsed)) {
      const normalized = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        typeof header !== 'string' ||
        /[\r\n\0]/.test(header) ||
        names.has(normalized)
      )
        throw new Error();
      names.add(normalized);
      Object.defineProperty(headers, name, {
        value: header,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return headers;
  } catch {
    throw new Error('OCPI_GRAPHQL_HEADERS must be a JSON object of valid string headers');
  }
}
