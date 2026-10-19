// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import type { ILogObj, Logger } from 'tslog';
import type { ChargingCalloutRow, ChargingCalloutStore } from './ChargingCalloutLedger.js';

export interface DeclineNotifierConfig {
  adapterBaseUrl?: string;
  webhookToken?: string;
  tenantMap: Record<string, string>;
  declineRetryBaseMs: number;
  declineRetryMaxMs: number;
  declineMaxAttempts: number;
  declineRequestTimeoutMs: number;
}

/**
 * Delivers durable DECLINED_BEFORE_POWER receipts to the adapter. Only rows Core ALREADY committed as declined are sent,
 * and only with the exact body the adapter validates: `{schemaVersion, tenantId, coreEvidenceRef}`. Anything that cannot
 * be delivered (no tenant mapping, adapter unreachable, adapter does not know the callout) is retried with backoff and
 * then abandoned - which leaves the adapter holding the slot. A receipt is never invented from a timeout or an age.
 */
export class ChargingCalloutDeclineNotifier {
  private flushing: Promise<number> | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: ChargingCalloutStore,
    private readonly config: DeclineNotifierConfig,
    private readonly logger: Logger<ILogObj>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Retry loop for deployments: restarts and failed deliveries are recovered from the durable rows. */
  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush().catch((e) => this.logger.error(`decline flush failed: ${e}`)), intervalMs);
    this.timer.unref?.(); // first pass after one interval: at boot the schema may not be synced yet
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over due declines; concurrent calls share one pass. Returns the number delivered. */
  flush(limit = 25): Promise<number> {
    this.flushing ??= this.run(limit).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(limit: number): Promise<number> {
    let delivered = 0;
    for (const row of await this.store.dueDeclines(this.clock(), limit)) {
      if (await this.deliver(row)) delivered += 1;
    }
    return delivered;
  }

  private async deliver(row: ChargingCalloutRow): Promise<boolean> {
    const tenant = this.config.tenantMap[String(row.tenantId)];
    if (!this.config.adapterBaseUrl || !this.config.webhookToken || !tenant || !row.coreEvidenceRef) {
      await this.fail(row, !tenant ? 'NO_TENANT_MAPPING' : 'DECLINE_TRANSPORT_NOT_CONFIGURED');
      return false;
    }
    const url = new URL(`/v1/charging/admission-callouts/${encodeURIComponent(row.id)}/decline`, this.config.adapterBaseUrl);
    url.searchParams.set('token', this.config.webhookToken);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: '1.0.0', tenantId: tenant, coreEvidenceRef: row.coreEvidenceRef }),
        signal: AbortSignal.timeout(this.config.declineRequestTimeoutMs),
      });
      if (res.status === 200) {
        const acknowledgment: unknown = await res.json();
        if (!acknowledgment || typeof acknowledgment !== 'object' ||
            (acknowledgment as { fenced?: unknown }).fenced !== true) {
          await this.fail(row, 'ADAPTER_DECLINE_NOT_FENCED');
          return false;
        }
        await this.store.markDeclineDelivered(row.id, this.clock());
        return true;
      }
      await this.fail(row, `ADAPTER_HTTP_${res.status}`);
    } catch (error) {
      await this.fail(row, `ADAPTER_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }

  private async fail(row: ChargingCalloutRow, reason: string): Promise<void> {
    const attempts = row.declineAttempts + 1;
    const abandoned = attempts >= this.config.declineMaxAttempts;
    const delay = Math.min(this.config.declineRetryBaseMs * 2 ** Math.min(attempts, 20), this.config.declineRetryMaxMs);
    this.logger.warn(`decline receipt ${row.id} not delivered (${reason}), attempt ${attempts}${abandoned ? ', abandoned' : ''}`);
    await this.store.recordDeclineFailure(row.id, reason, abandoned ? null : new Date(this.clock().getTime() + delay), abandoned);
  }
}
