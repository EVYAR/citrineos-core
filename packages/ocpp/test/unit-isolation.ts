// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { Socket } from 'node:net';
import { Sequelize } from 'sequelize';
import { afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
let violations: string[] = [];
function prohibited(operation: string): never {
  violations.push(operation);
  throw new Error(`UNIT_ISOLATION_UNMOCKED_${operation}`);
}
function installTraps() {
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => prohibited('SOCKET_CONNECT'));
  vi.spyOn(Sequelize.prototype, 'query').mockImplementation(() => prohibited('DATABASE_QUERY'));
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(() => prohibited('FETCH')),
  );
}
beforeAll(installTraps);
beforeEach(() => {
  violations = [];
  installTraps();
});
afterEach(() => {
  expect(
    violations,
    'unit fixtures must mock every database/network boundary before access',
  ).toEqual([]);
});
