// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { IModule } from '@citrineos/base';
import { OCPP_CallAction, RetryMessageError } from '@citrineos/base';
import { Logger } from 'tslog';
import { RabbitMqReceiver } from '../../../queue/rabbit-mq/receiver.js';
import {
  aConsumeMessage,
  aMockAmqpChannel,
  aMockChannelManager,
  aMockConnectionManager,
  aSystemConfigWithAmqp,
} from '../../providers/RabbitMqProvider.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(mode: 'module' | 'router' | 'reconnected-router', failure?: Error) {
  const gate = deferred(),
    events: string[] = [];
  let dependenciesClosed = false;
  const module = {
    handle: async () => {
      events.push('handler-start');
      await gate.promise;
      if (dependenciesClosed) throw new Error('durable write after dependency close');
      events.push('durable-write');
      if (failure) throw failure;
    },
  } as unknown as IModule;
  const channel = aMockAmqpChannel(),
    connection = aMockConnectionManager();
  vi.mocked(channel.ack).mockImplementation(() => {
    if (dependenciesClosed) throw new Error('ACK after close');
    events.push('ack');
  });
  vi.mocked(channel.nack).mockImplementation(() => {
    if (dependenciesClosed) throw new Error('NACK after close');
    events.push('nack');
  });
  const receiver = new RabbitMqReceiver({
    config: aSystemConfigWithAmqp(),
    channelManager: aMockChannelManager(channel, connection),
    module,
    routerMode: mode !== 'module',
    logger: new Logger({ minLevel: 6 }),
  });
  await receiver.subscribe('Provisioning', [OCPP_CallAction.BootNotification], {});
  if (mode === 'reconnected-router') {
    const connected = connection.on.mock.calls.find(([name]) => name === 'connected')![1];
    await connected();
  }
  const callback = vi.mocked(channel.consume).mock.calls.at(-1)![1];
  return {
    receiver,
    channel,
    gate,
    events,
    callback,
    closeDependencies() {
      dependenciesClosed = true;
      events.push('dependencies-closed');
    },
  };
}

describe('RabbitMQ receiver drains actual delivery/settlement before dependency teardown', () => {
  for (const mode of ['module', 'router', 'reconnected-router'] as const) {
    it(`waits for deferred module handler and ACK through ${mode} consumer callback`, async () => {
      const f = await fixture(mode),
        message = aConsumeMessage();
      const processing = Promise.resolve(f.callback(message));
      let closed = false;
      const shutdown = f.receiver.shutdown().then(() => {
        closed = true;
        f.closeDependencies();
      });
      await vi.waitFor(() => expect(f.channel.cancel).toHaveBeenCalled());
      expect(closed).toBe(false);
      expect(f.channel.ack).not.toHaveBeenCalled();
      f.gate.resolve();
      await processing;
      await shutdown;
      expect(f.events).toEqual(['handler-start', 'durable-write', 'ack', 'dependencies-closed']);
      expect(f.channel.ack).toHaveBeenCalledWith(message);
    });
  }

  for (const [name, failure, expected] of [
    ['retry', new RetryMessageError('retry after durable state'), 'nack'],
    ['handler error', new Error('ordinary module failure'), 'ack'],
  ] as const) {
    it(`preserves existing ${name} settlement while draining`, async () => {
      const f = await fixture('module', failure);
      const processing = Promise.resolve(f.callback(aConsumeMessage()));
      const shutdown = f.receiver.shutdown().then(() => f.closeDependencies());
      await vi.waitFor(() => expect(f.channel.cancel).toHaveBeenCalled());
      expect(f.events).toEqual(['handler-start']);
      f.gate.resolve();
      await processing;
      await shutdown;
      expect(f.events).toEqual(['handler-start', 'durable-write', expected, 'dependencies-closed']);
    });
  }

  for (const kind of ['ack', 'nack'] as const) {
    it(`surfaces closed-channel ${kind} failure from delivery and shutdown`, async () => {
      const f = await fixture(
        'module',
        kind === 'nack' ? new RetryMessageError('retry') : undefined,
      );
      const failure = new Error(`closed channel ${kind}`);
      vi.mocked(f.channel[kind]).mockImplementation(() => {
        throw failure;
      });
      const processing = Promise.resolve(f.callback(aConsumeMessage()));
      const delivered = expect(processing).rejects.toBe(failure);
      const shutdown = f.receiver.shutdown();
      const drained = expect(shutdown).rejects.toBe(failure);
      f.gate.resolve();
      await delivered;
      await drained;
    });
  }

  it('includes a delivery received while consumer cancellation is pending', async () => {
    const f = await fixture('module');
    vi.mocked(f.channel.cancel).mockImplementation(async () => {
      f.callback(aConsumeMessage());
      return {};
    });
    let closed = false;
    const shutdown = f.receiver.shutdown().then(() => {
      closed = true;
      f.closeDependencies();
    });
    await vi.waitFor(() => expect(f.events).toEqual(['handler-start']));
    expect(closed).toBe(false);
    f.gate.resolve();
    await shutdown;
    expect(f.events).toEqual(['handler-start', 'durable-write', 'ack', 'dependencies-closed']);
  });

  it('still drains handlers when cancellation fails, then propagates the original cancellation error', async () => {
    const f = await fixture('module'),
      failure = new Error('cancel failed');
    const processing = Promise.resolve(f.callback(aConsumeMessage()));
    vi.mocked(f.channel.cancel).mockRejectedValue(failure);
    const shutdown = f.receiver.shutdown(),
      failed = expect(shutdown).rejects.toBe(failure);
    await vi.waitFor(() => expect(f.channel.cancel).toHaveBeenCalled());
    expect(f.channel.ack).not.toHaveBeenCalled();
    f.gate.resolve();
    await processing;
    await failed;
    expect(f.events).toEqual(['handler-start', 'durable-write', 'ack']);
  });
});
