import { describe, expect, it } from 'vitest';
import { StatusIngressQueue } from '../../src/module/status-ingress-queue.js';

describe('bounded status ingress order', () => {
  it('retains socket order across asynchronous persistence and isolates stations', async () => {
    const queue = new StatusIngressQueue();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const finishing = queue.run('tenant:station', async () => {
      await barrier;
      seen.push('Finishing');
    });
    const available = queue.run('tenant:station', async () => { seen.push('Available'); });
    await queue.run('tenant:other', async () => { seen.push('other'); });
    expect(seen).toEqual(['other']);
    release();
    await Promise.all([finishing, available]);
    expect(seen).toEqual(['other', 'Finishing', 'Available']);
  });

  it('rejects overflow without dispatch and recovers after a failed persistence', async () => {
    const queue = new StatusIngressQueue(1);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run('station', async () => { await barrier; throw Error('persist failed'); });
    let dispatched = false;
    await expect(queue.run('station', async () => { dispatched = true; })).rejects.toThrow('STATUS_INGRESS_BACKPRESSURE');
    expect(dispatched).toBe(false);
    release();
    await expect(first).rejects.toThrow('persist failed');
    await queue.run('station', async () => { dispatched = true; });
    expect(dispatched).toBe(true);
  });
});
