// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from 'vitest';
import { CitrineOSServer } from '@/server/citrineos-server.js';
const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.clearAllTimers();
  vi.useRealTimers();
});
it('stops router/module receivers before closing Rabbit and clears the completed shutdown deadline', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const close = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const server = Object.create(CitrineOSServer.prototype) as CitrineOSServer;
  Object.assign(server, {
    _logger: { info: vi.fn() },
    _container: { hasRegistration: () => true, resolve: () => ({ shutdown: close('authorizer') }) },
    _config: { timeouts: { shutdownGracePeriodSeconds: 30 } },
    _healthCheckService: { shutdown: vi.fn() },
    _server: {
      close: (done: () => void) => {
        calls.push('http');
        done();
      },
    },
    _networkConnection: { shutdown: close('network') },
    _router: { shutdown: close('router') },
    modules: [{ shutdown: close('module') }],
    _channelManager: { closeAll: close('channels') },
    _connectionManager: { close: close('rabbit') },
    _sequelizeInstance: { connectionManager: { close: close('database') } },
  });
  await server.shutdown();
  expect(calls).toEqual([
    'http',
    'network',
    'router',
    'module',
    'authorizer',
    'channels',
    'rabbit',
    'database',
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
