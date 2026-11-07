// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import type { Channel } from 'amqplib';
import { RabbitMqModuleReceiver } from '@/transport/queue/rabbit-mq/module-receiver.js';
import { MessageOrigin, MessageState, OCPP_CallAction } from '@citrineos/types';
import { createTestContainer, getTestInstance } from '@test/test-container.js';
import {
  aConsumeMessage,
  aMockAmqpChannel,
  aMockChannelManager,
  aMockConnectionManager,
  aMockDeadLetterPublisher,
  aSystemConfigWithAmqp,
} from '@test/providers/rabbit-mq-provider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const channel = aMockAmqpChannel();
  const manager = aMockConnectionManager();
  let deliver: Parameters<Channel['consume']>[1] | undefined;
  vi.spyOn(channel, 'consume').mockImplementation(async (_queue, callback) => {
    deliver = callback;
    return { consumerTag: 'synthetic-consumer' };
  });
  const { container } = createTestContainer();
  const receiver = getTestInstance(container, RabbitMqModuleReceiver, {
    config: aSystemConfigWithAmqp(),
    channelManager: aMockChannelManager(channel, manager),
    deadLetterPublisher: aMockDeadLetterPublisher(),
    module: undefined,
  });
  await receiver.subscribe('synthetic-module', [OCPP_CallAction.Heartbeat], {
    origin: MessageOrigin.ChargingStationManagementSystem,
    state: String(MessageState.Request),
  });
  return {
    channel,
    manager,
    receiver,
    deliver: (message: ReturnType<typeof aConsumeMessage>) => {
      if (!deliver) throw new Error('consumer missing');
      deliver(message);
    },
  };
}
describe('EVYAR split receiver shutdown ownership', () => {
  it('cancels consumers then waits for active handlers and their acknowledgements', async () => {
    const { channel, receiver, deliver } = await fixture();
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(receiver, 'handle').mockImplementation(async () => {
      await barrier;
    });
    const ack = vi.spyOn(channel, 'ack');
    const cancel = vi.spyOn(channel, 'cancel');
    const message = aConsumeMessage({ action: OCPP_CallAction.Heartbeat });
    deliver(message);
    let stopped = false;
    const closing = receiver.shutdown().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('synthetic-consumer'));
    expect(stopped).toBe(false);
    expect(ack).not.toHaveBeenCalled();
    release();
    await closing;
    expect(ack).toHaveBeenCalledWith(message);
    expect(stopped).toBe(true);
  });
  it('does not hide settlement failure while shutting down', async () => {
    const { channel, receiver, deliver } = await fixture();
    vi.spyOn(receiver, 'handle').mockResolvedValue(undefined);
    const ack = vi.spyOn(channel, 'ack').mockImplementation(() => {
      throw new Error('ack failed');
    });
    deliver(aConsumeMessage({ action: OCPP_CallAction.Heartbeat }));
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    await expect(receiver.shutdown()).rejects.toThrow('ack failed');
  });
  it('does not restart subscriptions after intentional shutdown', async () => {
    const { channel, receiver, manager } = await fixture();
    await receiver.shutdown();
    const consume = vi.spyOn(channel, 'consume');
    consume.mockClear();
    const connected = manager.on.mock.calls.find(([event]) => event === 'connected')?.[1];
    if (typeof connected !== 'function') throw new Error('reconnect listener missing');
    await connected();
    expect(consume).not.toHaveBeenCalled();
  });
});
