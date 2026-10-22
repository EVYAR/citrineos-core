// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { Column, DataType, Index, Model, Table } from 'sequelize-typescript';

export type ChargingCalloutState = 'PENDING' | 'AUTHORIZED' | 'DECLINED_BEFORE_POWER';

/**
 * Durable ledger of target-specific real-time authorization callouts (CGP-0012). The row id IS the
 * `chargingCalloutRef` pinned into the callout. `DECLINED_BEFORE_POWER` is committed by an atomic PENDING -> DECLINED
 * compare-and-set BEFORE Core answers the charger, and fences every later attempt for the same request: a late callout
 * response can never turn a declined request into an authorization. `coreEvidenceRef` is that durable decision's id.
 */
@Table({ tableName: 'ChargingAdmissionCallouts', timestamps: true })
export class ChargingAdmissionCallout extends Model {
  @Column({ type: DataType.UUID, primaryKey: true, allowNull: false })
  declare id: string;

  @Index('ChargingAdmissionCallouts_request_idx')
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare tenantId: number;

  @Index('ChargingAdmissionCallouts_request_idx')
  @Column({ type: DataType.STRING(255), allowNull: false })
  declare ocppConnectionName: string;

  @Index('ChargingAdmissionCallouts_request_idx')
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare authorizationId: number;

  /** Core connector row id of the EXPLICIT target (0 would be ambiguous, so it is required). */
  @Index('ChargingAdmissionCallouts_request_idx')
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare connectorId: number;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare state: ChargingCalloutState;

  @Column({ type: DataType.DATE, allowNull: false })
  declare requestedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  @Column({ type: DataType.STRING(255), allowNull: true, unique: true })
  declare coreEvidenceRef: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare declineDeliveredAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare declineAttempts: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare nextDeclineAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare lastDeclineError: string | null;

  /** True once the retry budget is spent: the receipt is NOT delivered and the adapter keeps the slot held. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare declineAbandoned: boolean;
}
