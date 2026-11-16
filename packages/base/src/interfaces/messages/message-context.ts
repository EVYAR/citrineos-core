// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import type { ChargingAdmissionProvenance } from '@citrineos/types';


/**
 * IMessageContext
 *
 * The context of any OCPP message.
 */
export interface IMessageContext {
  correlationId: string;
  /** Original durable StatusNotification CALL, persisted before module fanout. */
  statusIngressMessageId?: number;
  statusIngressConnection?: string;
  /** Internal admission evidence: a named physical target must not fall back to a station guess. */
  requiresExplicitAuthorizationTarget?: boolean;
  /** Bound by the native Start handler, never trusted from transport metadata. */
  nativeAdmissionRequest?: { id: string; hash: string };
  /** Set only by a durably committed real-time charging admission. */
  chargingAdmissionProvenance?: ChargingAdmissionProvenance;
  tenantId: number;
  ocppConnectionName: string;
  timestamp: string; // Iso Timestamp
  /**
   * Overrides the configured age, from `timestamp`, after which the CSMS drops this Call.
   * 0 never drops it.
   */
  staleAfterSeconds?: number;
}
