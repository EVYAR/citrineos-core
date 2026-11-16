// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import type { SequelizeStatusIngressRepository } from '@citrineos/dal';
import { isDeepStrictEqual } from 'node:util';
import { vi } from 'vitest';

type Receipt = { id: number; protocol: string; frame: unknown };
type MemoryState = {
  connections: Map<string, string>;
  receipts: Map<string, Receipt>;
  nextId: number;
};

// Models connection ownership and transactional receipt identity, not database projections.
export function makeStatusIngressRepository() {
  let state: MemoryState = { connections: new Map(), receipts: new Map(), nextId: 1 };
  let tail = Promise.resolve();
  async function transaction<T>(work: (draft: MemoryState) => Promise<T>): Promise<T> {
    const preceding = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    const draft: MemoryState = {
      connections: new Map(state.connections),
      receipts: new Map(state.receipts),
      nextId: state.nextId,
    };
    try {
      const result = await work(draft);
      state = draft;
      return result;
    } finally {
      release();
    }
  }
  return {
    setConnection: vi
      .fn<SequelizeStatusIngressRepository['setConnection']>()
      .mockImplementation((tenantId, station, connection, isCurrent) =>
        transaction(async (draft) => {
          if (!(await isCurrent())) throw new Error('STATUS_INGRESS_RETIRED_REGISTRATION');
          draft.connections.set(JSON.stringify([tenantId, station]), connection);
        }),
      ),
    reserve: vi
      .fn<SequelizeStatusIngressRepository['reserve']>()
      .mockImplementation((tenantId, station, connection, correlationId, protocol, frame) =>
        transaction(async (draft) => {
          if (draft.connections.get(JSON.stringify([tenantId, station])) !== connection) {
            throw new Error('STATUS_INGRESS_RETIRED_CONNECTION');
          }
          const key = JSON.stringify([tenantId, station, connection, correlationId]);
          const existing = draft.receipts.get(key);
          if (existing) {
            if (existing.protocol !== protocol || !isDeepStrictEqual(existing.frame, frame)) {
              throw new Error('STATUS_INGRESS_IDENTITY_REUSED');
            }
            return existing.id;
          }
          const id = draft.nextId++;
          draft.receipts.set(key, { id, protocol, frame: structuredClone(frame) });
          return id;
        }),
      ),
    apply: vi
      .fn<SequelizeStatusIngressRepository['apply']>()
      .mockRejectedValue(
        new Error('Projection application requires the explicit database fixture'),
      ),
  } satisfies Pick<SequelizeStatusIngressRepository, 'setConnection' | 'reserve' | 'apply'>;
}
