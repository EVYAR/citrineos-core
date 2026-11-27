// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({ tableName: 'StatusIngressReceipts', timestamps: true })
export class StatusIngressReceipt extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;
  @Column(DataType.INTEGER) declare tenantId: number;
  @Column(DataType.INTEGER) declare stationId: number;
  @Column(DataType.UUID) declare connection: string;
  @Column(DataType.STRING) declare correlationId: string;
  @Column(DataType.STRING) declare protocol: string;
  @Column(DataType.JSONB) declare frame: unknown;
  @Column(DataType.DATE) declare timestamp: Date;
}
