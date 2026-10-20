// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { MessageState, MessageOrigin, type OCPPMessageDto } from '@citrineos/base';
import type { IOCPPMessageRepository } from '../../../interfaces/repositories.js';
import { isDeepStrictEqual } from 'node:util';
import { OCPPMessage } from '../model/OCPPMessage.js';
import { SequelizeRepository, type SequelizeRepositoryDependencies } from './Base.js';

export class SequelizeOCPPMessageRepository
  extends SequelizeRepository<OCPPMessage>
  implements IOCPPMessageRepository
{
  constructor({ config, logger, sequelizeInstance }: SequelizeRepositoryDependencies) {
    super({ config, namespace: OCPPMessage.MODEL_NAME, logger, sequelizeInstance });
  }

  public async reserveStatusIngress(tenantId: number, message: OCPPMessageDto): Promise<OCPPMessage> {
    if (message.tenantId !== tenantId || !message.statusIngressConnection ||
        message.action !== 'StatusNotification' || message.state !== MessageState.Request ||
        message.origin !== MessageOrigin.ChargingStation || !message.correlationId) {
      throw new Error('STATUS_INGRESS_INVALID_IDENTITY');
    }
    // Station lock serializes same-identity requests across processes. Socket
    // ingress ordering itself is established before any async router lookup.
    return this.s.transaction(async (transaction) => {
      const [stations] = await this.s.query('SELECT id FROM "ChargingStations" WHERE "tenantId"=:tenantId AND "ocppConnectionName"=:station AND "statusIngressConnection"=:connection FOR UPDATE', {
        replacements: { tenantId, station: message.ocppConnectionName, connection: message.statusIngressConnection }, transaction,
      });
      if (stations.length !== 1) throw new Error('STATUS_INGRESS_RETIRED_CONNECTION');
      const existing = await OCPPMessage.findOne({ where: {
        tenantId, ocppConnectionName: message.ocppConnectionName,
        statusIngressConnection: message.statusIngressConnection, correlationId: message.correlationId,
      }, transaction });
      if (existing) {
        if (existing.action !== message.action || existing.protocol !== message.protocol ||
            existing.origin !== message.origin || (existing.state as unknown) !== String(message.state) ||
            !isDeepStrictEqual(existing.message, message.message)) {
          throw new Error('STATUS_INGRESS_IDENTITY_REUSED');
        }
        return existing;
      }
      // OCPP wire state is numeric; the canonical legacy column is VARCHAR.
      return OCPPMessage.create({ ...message, tenantId, state: String(message.state) }, { transaction });
    });
  }

  public async createOCPPMessage(tenantId: number, message: OCPPMessageDto): Promise<OCPPMessage> {
    if (message.correlationId) {
      const correlatedMessages = await this.readAllByQuery(tenantId, {
        where: {
          tenantId,
          correlationId: message.correlationId,
          ocppConnectionName: message.ocppConnectionName,
          requestMessageId: null,
        },
      });
      if (correlatedMessages.length > 0) {
        if (correlatedMessages.length > 1) {
          this.logger.warn(
            `Multiple correlated messages found for correlationId ${message.correlationId} and tenantId ${tenantId}. This should not happen.`,
          );
        }
        const correlatedMessage: OCPPMessage | undefined = correlatedMessages.sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        )[0]; // Get the oldest message

        // Update the action of the correlated message if it's missing and we have it in the incoming message, or vice versa
        if (correlatedMessage.action === undefined && message.action) {
          correlatedMessage.action = message.action;
          await correlatedMessage.save();
        } else if (message.action === undefined && correlatedMessage.action) {
          message.action = correlatedMessage.action;
        }

        if (message.state === MessageState.Request) {
          this.logger.debug(
            `Saving request message found for correlationId ${message.correlationId} and tenantId ${tenantId}, will update response`,
          );
          const createdMessage = await this.create(tenantId, OCPPMessage.build({ ...message }));
          correlatedMessage.requestMessageId = createdMessage.id;
          await correlatedMessage.save();
          return createdMessage;
        } else {
          this.logger.debug(
            `Saving response message found for correlationId ${message.correlationId} and tenantId ${tenantId} with action ${correlatedMessage.action}`,
          );
          message.requestMessageId = correlatedMessage.id;
          return this.create(tenantId, OCPPMessage.build({ ...message }));
        }
      } else {
        // No correlated message found, ideally because this is the request message arriving before the response
        this.logger.debug(
          `No correlated message found for correlationId ${message.correlationId} and tenantId ${tenantId} with action ${message.action}. Saving message as-is.`,
        );
        return this.create(tenantId, OCPPMessage.build({ ...message }));
      }
    } else {
      this.logger.warn(
        `No correlationId found for message with tenantId ${tenantId} and action ${message.action}. Saving message as-is without correlation.`,
      );
      return this.create(tenantId, OCPPMessage.build({ ...message }));
    }
  }

  public async getRequestByCorrelationId(
    tenantId: number,
    correlationId: string,
  ): Promise<OCPPMessage | undefined> {
    return this.readOnlyOneByQuery(tenantId, {
      where: { tenantId, correlationId, requestMessageId: null },
    });
  }
}

export default SequelizeOCPPMessageRepository;
