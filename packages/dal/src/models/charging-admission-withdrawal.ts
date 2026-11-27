// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import type { ChargingAdmissionWithdrawalReceipt } from '@citrineos/types';

/** Append-only owner evidence. Historical callout/native rows are not rewritten. */
@Table({ tableName: 'ChargingAdmissionWithdrawals', timestamps: false })
export class ChargingAdmissionWithdrawal extends Model {
  @Column({ type: DataType.UUID, primaryKey: true }) declare id: string;
  @Column(DataType.INTEGER) declare tenantId: number;
  @Column(DataType.UUID) declare chargingCalloutRef: string;
  @Column(DataType.STRING(255)) declare idempotencyKey: string;
  @Column(DataType.CHAR(64)) declare requestHash: string;
  @Column(DataType.TEXT) declare actorSubject: string;
  @Column(DataType.INTEGER) declare stationId: number;
  @Column(DataType.INTEGER) declare authorizedConnectorId: number;
  @Column(DataType.INTEGER) declare commercialConnectorId: number;
  @Column(DataType.BIGINT) declare fence: string;
  @Column(DataType.DATE) declare withdrawnAt: Date;
  @Column(DataType.JSONB) declare receipt: ChargingAdmissionWithdrawalReceipt;
}

/** One immutable grant consumption per exact native transaction composite identity. */
@Table({ tableName: 'ChargingAdmissionConsumptions', timestamps: false })
export class ChargingAdmissionConsumption extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true }) declare transactionDatabaseId: number;
  @Column({ type: DataType.DATE, primaryKey: true }) declare transactionCreatedAt: Date;
  @Column(DataType.INTEGER) declare tenantId: number;
  @Column(DataType.INTEGER) declare stationId: number;
  @Column(DataType.INTEGER) declare connectorId: number;
  @Column(DataType.INTEGER) declare authorizationId: number;
  @Column(DataType.UUID) declare chargingCalloutRef: string;
  @Column(DataType.TEXT) declare nativeRequestId: string;
  @Column(DataType.CHAR(64)) declare nativeRequestHash: string;
  @Column(DataType.DATE) declare createdAt: Date;
  @Column(DataType.JSONB) declare snapshot: Record<string, unknown>;
}
