// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from 'node:util';
import type { ConnectorDto, StatusNotificationDto } from '@citrineos/types';
import { OCPPVersion } from '@citrineos/types';
import { Op } from 'sequelize';
import { ChargingStation } from '../../models/location/charging-station.js';
import { Connector } from '../../models/location/connector.js';
import { Evse } from '../../models/location/evse.js';
import { StatusNotification } from '../../models/location/status-notification.js';
import { VariableAttribute } from '../../models/device-model/variable-attribute.js';
import { StatusIngressReceipt } from '../../models/status-ingress-receipt.js';
import { DefaultSequelizeInstance } from '../../db/sequelize/util.js';
import type { SequelizeRepositoryDependencies } from './base.js';
import { statusIngressWins } from './status-ingress-order.js';

export interface StatusIngressIdentity {
  messageId: number;
  connection: string;
  correlationId: string;
  protocol: string;
}
export interface StatusDeviceEffect {
  componentId: number;
  variableId: number;
  evseDatabaseId?: number | null;
  value: string;
  generatedAt: string;
}

export class SequelizeStatusIngressRepository {
  private readonly s;
  constructor({ config, logger, sequelizeInstance }: SequelizeRepositoryDependencies) {
    this.s = sequelizeInstance ?? DefaultSequelizeInstance.getInstance(config, logger);
  }

  async setConnection(
    tenantId: number,
    station: string,
    connection: string,
    isCurrent: () => Promise<boolean>,
  ): Promise<void> {
    await this.s.transaction(async (transaction) => {
      const owner = await ChargingStation.findOne({
        where: { tenantId, ocppConnectionName: station },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!owner) throw new Error('STATUS_INGRESS_STATION_MISSING');
      if (!(await isCurrent())) throw new Error('STATUS_INGRESS_RETIRED_REGISTRATION');
      await owner.update({ statusIngressConnection: connection }, { transaction });
    });
  }

  async reserve(
    tenantId: number,
    station: string,
    connection: string,
    correlationId: string,
    protocol: string,
    frame: unknown,
    timestamp: Date,
  ): Promise<number> {
    return this.s.transaction(async (transaction) => {
      const owner = await ChargingStation.findOne({
        where: { tenantId, ocppConnectionName: station },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!owner || owner.statusIngressConnection !== connection) {
        throw new Error('STATUS_INGRESS_RETIRED_CONNECTION');
      }
      const where = { tenantId, stationId: owner.id, connection, correlationId };
      const existing = await StatusIngressReceipt.findOne({ where, transaction });
      if (existing) {
        if (existing.protocol !== protocol || !isDeepStrictEqual(existing.frame, frame)) {
          throw new Error('STATUS_INGRESS_IDENTITY_REUSED');
        }
        return existing.id;
      }
      return (
        await StatusIngressReceipt.create({ ...where, protocol, frame, timestamp }, { transaction })
      ).id;
    });
  }

  async apply(
    tenantId: number,
    station: string,
    status: StatusNotificationDto,
    connector: ConnectorDto | undefined,
    payload: unknown,
    ingress: StatusIngressIdentity,
    broadcast = false,
    effects: StatusDeviceEffect[] = [],
  ): Promise<{
    applied: boolean;
    observations: Array<{ statusNotification: StatusNotification; connector: Connector }>;
  }> {
    return this.s.transaction(async (transaction) => {
      const owner = await ChargingStation.findOne({
        where: { tenantId, ocppConnectionName: station },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!owner) throw new Error('STATUS_INGRESS_STATION_MISSING');
      const receipt = await StatusIngressReceipt.findOne({
        where: {
          id: ingress.messageId,
          tenantId,
          stationId: owner.id,
          connection: ingress.connection,
          correlationId: ingress.correlationId,
          protocol: ingress.protocol,
        },
        transaction,
      });
      if (
        !receipt ||
        !Array.isArray(receipt.frame) ||
        receipt.frame[0] !== 2 ||
        receipt.frame[1] !== ingress.correlationId ||
        receipt.frame[2] !== 'StatusNotification' ||
        !isDeepStrictEqual(receipt.frame[3], payload)
      )
        throw new Error('STATUS_INGRESS_RECEIPT_MISMATCH');
      const replay = await StatusNotification.findOne({
        where: { tenantId, ingressMessageId: receipt.id },
        transaction,
      });
      if (replay) return { applied: false, observations: [] };
      const observedAt = Date.parse(status.timestamp ?? receipt.timestamp.toISOString());
      if (!Number.isFinite(observedAt)) throw new Error('STATUS_INGRESS_INVALID_TIMESTAMP');
      const is16 = ingress.protocol === OCPPVersion.OCPP1_6;
      const targets: Array<{ status: StatusNotificationDto; connector?: ConnectorDto }> = [];
      const observations: Array<{ statusNotification: StatusNotification; connector: Connector }> =
        [];
      if (broadcast) {
        await StatusNotification.create(
          { ...status, tenantId, stationId: owner.id, ingressMessageId: receipt.id },
          { transaction },
        );
        const commissioned = await Connector.findAll({
          where: { tenantId, stationId: owner.id, connectorId: { [Op.gt]: 0 } },
          transaction,
        });
        for (const target of commissioned) {
          const evse = await Evse.findOne({
            where: { id: target.evseId, tenantId, stationId: owner.id },
            transaction,
          });
          if (!evse) throw new Error('STATUS_INGRESS_BROADCAST_TOPOLOGY_MISSING');
          targets.push({
            status: { ...status, connectorId: target.connectorId!, evseId: evse.evseTypeId },
            connector: {
              ...target.get(),
              ...connector,
              id: target.id,
              evseId: target.evseId,
              connectorId: target.connectorId,
              stationId: owner.id,
            },
          });
        }
      } else targets.push({ status, connector });
      let applied = false;
      for (const target of targets) {
        const where = {
          tenantId,
          stationId: owner.id,
          ...(is16
            ? { connectorId: target.status.connectorId }
            : { evseId: target.connector?.evseId, evseTypeConnectorId: target.status.connectorId }),
        };
        const current = await Connector.findOne({
          where,
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const previous =
          current?.latestStatusNotificationId == null
            ? null
            : await StatusNotification.findOne({
                where: { tenantId, id: current.latestStatusNotificationId },
                transaction,
              });
        const wins =
          !previous ||
          statusIngressWins(
            { observedAt, messageId: receipt.id },
            {
              observedAt: Date.parse(previous.timestamp ?? previous.createdAt.toISOString()),
              messageId: previous.ingressMessageId ?? null,
            },
          );
        const saved = await StatusNotification.create(
          {
            ...target.status,
            tenantId,
            stationId: owner.id,
            connectorDatabaseId: current?.id,
            ingressMessageId: receipt.id,
          },
          { transaction },
        );
        if (!wins || owner.statusIngressConnection !== ingress.connection) continue;
        if (target.connector) {
          const values = {
            ...target.connector,
            tenantId,
            stationId: owner.id,
            latestStatusNotificationId: saved.id,
          };
          const row = current
            ? await current.update(values, { transaction })
            : await Connector.create(values, { transaction });
          if (saved.connectorDatabaseId !== row.id)
            await saved.update({ connectorDatabaseId: row.id }, { transaction });
          observations.push({ statusNotification: saved, connector: row });
        }
        applied = true;
      }
      if (applied)
        for (const effect of effects) {
          const where = {
            tenantId,
            stationId: owner.id,
            componentId: effect.componentId,
            variableId: effect.variableId,
            type: 'Actual',
          };
          const values = {
            ...where,
            value: effect.value,
            generatedAt: effect.generatedAt,
            evseDatabaseId: effect.evseDatabaseId ?? null,
            mutability: 'ReadWrite',
            persistent: false,
            constant: false,
            dataType: null,
          };
          const [attribute, created] = await VariableAttribute.findOrCreate({
            where,
            defaults: values,
            transaction,
          });
          if (!created)
            await attribute.update(
              { value: effect.value, generatedAt: effect.generatedAt },
              { transaction },
            );
        }
      return { applied, observations };
    });
  }
}
