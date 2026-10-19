// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { ChargingCalloutState } from '@dal/layers/sequelize/index.js';

export interface ChargingCalloutKey {
  tenantId: number;
  ocppConnectionName: string;
  authorizationId: number;
  connectorId: number;
}

export interface ChargingCalloutRow extends ChargingCalloutKey {
  id: string;
  state: ChargingCalloutState;
  requestedAt: Date;
  decidedAt: Date | null;
  coreEvidenceRef: string | null;
  declineDeliveredAt: Date | null;
  declineAttempts: number;
  nextDeclineAt: Date | null;
  lastDeclineError: string | null;
  declineAbandoned: boolean;
}

export type BeginResult =
  /** A callout may be made with this ref (new, or the still-PENDING one for the same request, reused). */
  | { kind: 'CALLOUT'; ref: string }
  /** The same request was declined before power and is still fenced: answer declined, make NO callout. */
  | { kind: 'FENCED_DECLINED'; ref: string; coreEvidenceRef: string };

/**
 * Durable storage port for the callout ledger. Every state change is a compare-and-set so concurrent or late
 * deciders cannot move a request out of a terminal state.
 */
export interface ChargingCalloutStore {
  /** Reuse the PENDING ref of the same request within `reuseWindowMs`, report an active decline fence, else create a PENDING row. */
  begin(key: ChargingCalloutKey, now: Date, reuseWindowMs: number, fenceMs: number): Promise<BeginResult>;
  /** PENDING -> AUTHORIZED. false when the request is no longer PENDING (e.g. already fenced as declined). */
  markAuthorized(ref: string, now: Date): Promise<boolean>;
  /** PENDING -> DECLINED_BEFORE_POWER with a durable evidence ref. false when the request is no longer PENDING. */
  markDeclined(ref: string, coreEvidenceRef: string, now: Date): Promise<boolean>;
  get(ref: string): Promise<ChargingCalloutRow | null>;
  /** Declined rows whose receipt is not delivered, due for a (re)try. */
  dueDeclines(now: Date, limit: number): Promise<ChargingCalloutRow[]>;
  markDeclineDelivered(ref: string, now: Date): Promise<void>;
  recordDeclineFailure(ref: string, error: string, nextAt: Date | null, abandoned: boolean): Promise<void>;
}

export const newCoreEvidenceRef = () => `core-decision:${randomUUID()}`;

/** Same semantics as the Sequelize store, for unit tests and single-process fakes. */
export class InMemoryChargingCalloutStore implements ChargingCalloutStore {
  readonly rows = new Map<string, ChargingCalloutRow>();

  async begin(key: ChargingCalloutKey, now: Date, reuseWindowMs: number, fenceMs: number): Promise<BeginResult> {
    const same = [...this.rows.values()]
      .filter((r) => r.tenantId === key.tenantId && r.ocppConnectionName === key.ocppConnectionName && r.authorizationId === key.authorizationId && r.connectorId === key.connectorId)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
    const latest = same[0];
    if (latest) {
      if (latest.state === 'DECLINED_BEFORE_POWER' && latest.decidedAt && now.getTime() - latest.decidedAt.getTime() < fenceMs) {
        return { kind: 'FENCED_DECLINED', ref: latest.id, coreEvidenceRef: latest.coreEvidenceRef! };
      }
      if (latest.state === 'PENDING' && now.getTime() - latest.requestedAt.getTime() < reuseWindowMs) return { kind: 'CALLOUT', ref: latest.id };
    }
    const row: ChargingCalloutRow = { ...key, id: randomUUID(), state: 'PENDING', requestedAt: now, decidedAt: null, coreEvidenceRef: null, declineDeliveredAt: null, declineAttempts: 0, nextDeclineAt: null, lastDeclineError: null, declineAbandoned: false };
    this.rows.set(row.id, row);
    return { kind: 'CALLOUT', ref: row.id };
  }

  async markAuthorized(ref: string, now: Date): Promise<boolean> {
    const r = this.rows.get(ref);
    if (!r || r.state !== 'PENDING') return false;
    r.state = 'AUTHORIZED';
    r.decidedAt = now;
    return true;
  }

  async markDeclined(ref: string, coreEvidenceRef: string, now: Date): Promise<boolean> {
    const r = this.rows.get(ref);
    if (!r || r.state !== 'PENDING') return false;
    r.state = 'DECLINED_BEFORE_POWER';
    r.decidedAt = now;
    r.coreEvidenceRef = coreEvidenceRef;
    r.nextDeclineAt = now;
    return true;
  }

  async get(ref: string) { return this.rows.get(ref) ?? null; }

  async dueDeclines(now: Date, limit: number) {
    return [...this.rows.values()].filter((r) => r.state === 'DECLINED_BEFORE_POWER' && !r.declineDeliveredAt && !r.declineAbandoned && (r.nextDeclineAt === null || r.nextDeclineAt <= now)).slice(0, limit);
  }

  async markDeclineDelivered(ref: string, now: Date) {
    const r = this.rows.get(ref);
    if (r) { r.declineDeliveredAt = now; r.lastDeclineError = null; }
  }

  async recordDeclineFailure(ref: string, error: string, nextAt: Date | null, abandoned: boolean) {
    const r = this.rows.get(ref);
    if (r) { r.declineAttempts += 1; r.lastDeclineError = error.slice(0, 500); r.nextDeclineAt = nextAt; r.declineAbandoned = abandoned; }
  }
}
