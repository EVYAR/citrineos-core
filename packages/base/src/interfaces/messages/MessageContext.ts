// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

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
  tenantId: number;
  ocppConnectionName: string;
  timestamp: string; // Iso Timestamp
}
