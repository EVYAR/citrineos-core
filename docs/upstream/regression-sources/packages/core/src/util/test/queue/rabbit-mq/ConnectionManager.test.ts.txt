// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import amqp from 'amqplib';
import { RabbitMQConnectionManager } from '../../../queue/rabbit-mq/ConnectionManager.js';
vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const broker = () => {
  const connection = new EventEmitter();
  return Object.assign(connection, {
    close: vi.fn(async () => {
      connection.emit('close');
    }),
  });
};
const manager = () =>
  new RabbitMQConnectionManager({ maxReconnectDelay: 10000, amqpUrl: 'amqp://fixture' });
it('never schedules a reconnect after an intentional close', async () => {
  vi.useFakeTimers();
  const connection = broker();
  vi.mocked(amqp.connect).mockResolvedValue(connection as never);
  const subject = manager();
  await subject.connect();
  await subject.close();
  await vi.advanceTimersByTimeAsync(20000);
  expect(amqp.connect).toHaveBeenCalledTimes(1);
  expect(subject.isConnected()).toBe(false);
  await expect(subject.connect()).rejects.toThrow('closed');
  expect(vi.getTimerCount()).toBe(0);
});
it('closes a connection which finishes opening after shutdown', async () => {
  vi.useFakeTimers();
  const connection = broker();
  let resolve!: (value: never) => void;
  vi.mocked(amqp.connect).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const subject = manager();
  const connecting = subject.connect();
  const rejected = expect(connecting).rejects.toThrow('closed during connect');
  await subject.close();
  resolve(connection as never);
  await rejected;
  expect(connection.close).toHaveBeenCalledTimes(1);
  expect(subject.isConnected()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
