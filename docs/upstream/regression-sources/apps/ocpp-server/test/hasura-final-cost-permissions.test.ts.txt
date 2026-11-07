// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
// Reuse the YAML parser already pinned by the workspace ESLint toolchain.
const require = createRequire(import.meta.url),
  eslintRequire = createRequire(require.resolve('eslint/package.json'));
const yaml = createRequire(eslintRequire.resolve('@eslint/eslintrc/package.json'))('js-yaml') as {
  load: (text: string) => Metadata;
};
interface Permission {
  role: string;
  permission: {
    columns: string[];
    filter: Record<string, unknown>;
    check?: Record<string, unknown>;
  };
}
interface Metadata {
  table: { name: string; schema: string };
  select_permissions: Permission[];
  update_permissions: Permission[];
  insert_permissions?: Permission[];
  delete_permissions?: Permission[];
}
const table = yaml.load(
  readFileSync(
    new URL(
      '../hasura-metadata/databases/default/tables/public_Transactions.yaml',
      import.meta.url,
    ),
    'utf8',
  ),
);
describe('canonical CSMS final-cost Hasura permissions', () => {
  it('grants only the final cost and bookkeeping timestamp update', () => {
    expect(table.table).toEqual({ name: 'Transactions', schema: 'public' });
    expect(table.update_permissions.map((p) => p.role)).toEqual(['csms_final_cost']);
    expect(table.update_permissions[0]!.permission.columns).toEqual(['totalCost', 'updatedAt']);
  });
  it('fences both old and resulting rows to the request tenant', () => {
    const p = table.update_permissions[0]!.permission;
    expect(p.filter).toEqual({ tenantId: { _eq: 'x-hasura-tenant-id' } });
    expect(p.check).toEqual(p.filter);
  });
  it('exposes only columns needed to anchor mutation and return actual cost', () => {
    const p = table.select_permissions.find((p) => p.role === 'csms_final_cost')!.permission;
    expect(p.columns).toEqual(['id', 'tenantId', 'ocppConnectionName', 'totalCost']);
    expect(p.filter).toEqual({ tenantId: { _eq: 'x-hasura-tenant-id' } });
  });
  it('does not add user-role writes, identity writes, inserts or deletes', () => {
    expect(table.select_permissions.find((p) => p.role === 'user')).toBeDefined();
    expect(table.update_permissions.find((p) => p.role === 'user')).toBeUndefined();
    expect(table.insert_permissions?.find((p) => p.role === 'csms_final_cost')).toBeUndefined();
    expect(table.delete_permissions?.find((p) => p.role === 'csms_final_cost')).toBeUndefined();
    expect(table.update_permissions[0]!.permission.columns).not.toEqual(
      expect.arrayContaining(['tenantId']),
    );
    expect(table.update_permissions[0]!.permission.columns).not.toContain('transactionId');
  });
});
