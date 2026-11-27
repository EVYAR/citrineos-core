// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/** Internal Core owner API; deliberately not a canonical commercial admission schema. */
export interface ChargingAdmissionWithdrawalRequest {
  schemaVersion: '1.0.0';
  chargingCalloutRef: string;
  idempotencyKey: string;
  expectedCommercialTarget: {
    ocppConnectionName: string;
    protocol: 'ocpp1.6';
    ocppEvseId: number;
    ocppConnectorId: number;
  };
}

export interface ChargingAdmissionNativeSession {
  nativeTransaction: { id: number; createdAt: string; stationId: number; transactionId: string };
  startEvent: { id: number; createdAt: string; timestamp: string; meterStartWh: string };
  stopEvent: { id: number; createdAt: string; timestamp: string; meterStopWh: string };
  endedAt: string;
  deliveredEnergyWh: '0';
}

export interface ChargingAdmissionWithdrawalReceipt {
  schemaVersion: 'CORE_AUTHORIZED_TARGET_WITHDRAWAL_V1';
  coreEvidenceRef: string;
  chargingCalloutRef: string;
  coreTenantId: number;
  ocppConnectionName: string;
  authorizationId: number;
  originalDecision: 'AUTHORIZED';
  originalDecisionRecordedAt: string;
  authorizedTarget: { nativeConnectorId: number; protocol: 'ocpp1.6'; ocppEvseId: number; ocppConnectorId: number };
  requestedCommercialTarget: { nativeConnectorId: number; protocol: 'ocpp1.6'; ocppEvseId: number; ocppConnectorId: number };
  withdrawal: { state: 'WITHDRAWN'; fence: string; withdrawnAt: string; durable: true };
  nativeSessionScope: 'ALL_RETAINED_SESSIONS_FOR_AUTHORIZED_NATIVE_CONNECTOR';
  nativeSessions: ChargingAdmissionNativeSession[];
  causalCalloutTransactionBinding: 'NOT_ASSERTED_FOR_LEGACY_ROWS';
  requestHash: string;
  actorSubject: string;
}

/** Set only by the real-time authorizer after committing this exact grant. */
export interface ChargingAdmissionProvenance {
  schemaVersion: '1.0.0';
  chargingCalloutRef: string;
  nativeRequestId: string;
  nativeRequestHash: string;
}
