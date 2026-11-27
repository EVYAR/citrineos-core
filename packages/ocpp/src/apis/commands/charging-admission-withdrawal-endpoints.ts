// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { AbstractEndpoint, type AbstractEndpointDependencies, type ICommandEndpointMetadata } from '@citrineos/base';
import { HttpMethod, type ChargingAdmissionWithdrawalRequest } from '@citrineos/types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChargingAdmissionWithdrawalService } from '../../services/authorizer/charging-admission-withdrawal-service.js';

const querySchema = {
  type: 'object', additionalProperties: false, required: ['tenantId'],
  properties: { tenantId: { type: 'integer', minimum: 1 } },
};
const bodySchema = {
  // Preserve extras until maxProperties rejects them; Fastify otherwise silently strips them.
  type: 'object', additionalProperties: true, maxProperties: 4,
  required: ['schemaVersion', 'chargingCalloutRef', 'idempotencyKey', 'expectedCommercialTarget'],
  properties: {
    schemaVersion: { type: 'string', const: '1.0.0' },
    chargingCalloutRef: { type: 'string', format: 'uuid' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 255 },
    expectedCommercialTarget: {
      type: 'object', additionalProperties: true, maxProperties: 4,
      required: ['ocppConnectionName', 'protocol', 'ocppEvseId', 'ocppConnectorId'],
      properties: {
        ocppConnectionName: { type: 'string', minLength: 1, maxLength: 36 },
        protocol: { type: 'string', const: 'ocpp1.6' },
        ocppEvseId: { type: 'integer', minimum: 1 },
        ocppConnectorId: { type: 'integer', minimum: 1 },
      },
    },
  },
};
interface Dependencies extends AbstractEndpointDependencies {
  chargingAdmissionWithdrawalService: ChargingAdmissionWithdrawalService;
}
type WriteRoute = { Querystring: { tenantId: number }; Body: ChargingAdmissionWithdrawalRequest };
type ReadRoute = { Querystring: { tenantId: number; chargingCalloutRef: string } };

function owner(request: FastifyRequest, tenantId: number): string {
  if (!request.user || !request.user.roles.includes('evyar-adapter') ||
      request.user.tenantId !== String(tenantId) || !request.user.id) {
    const error = new Error('Exact authenticated Adapter owner and tenant are required') as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  return request.user.id;
}

export class PostChargingAdmissionWithdrawalEndpoint extends AbstractEndpoint<WriteRoute> {
  static readonly route: ICommandEndpointMetadata = {
    method: HttpMethod.Post, path: '/chargingAdmissionWithdrawal', querySchema, bodySchema,
  };
  private readonly service: ChargingAdmissionWithdrawalService;
  constructor({ logger, chargingAdmissionWithdrawalService }: Dependencies) {
    super(logger);
    this.service = chargingAdmissionWithdrawalService;
  }
  async handle(request: FastifyRequest<WriteRoute>) {
    return this.service.withdraw(request.query.tenantId, request.body, owner(request, request.query.tenantId));
  }
}

export class GetChargingAdmissionWithdrawalEndpoint extends AbstractEndpoint<ReadRoute> {
  static readonly route: ICommandEndpointMetadata = {
    method: HttpMethod.Get, path: '/chargingAdmissionWithdrawal',
    querySchema: {
      ...querySchema, required: ['tenantId', 'chargingCalloutRef'],
      properties: { ...querySchema.properties, chargingCalloutRef: { type: 'string', format: 'uuid' } },
    },
  };
  private readonly service: ChargingAdmissionWithdrawalService;
  constructor({ logger, chargingAdmissionWithdrawalService }: Dependencies) {
    super(logger);
    this.service = chargingAdmissionWithdrawalService;
  }
  async handle(request: FastifyRequest<ReadRoute>, reply: FastifyReply) {
    const receipt = await this.service.read(request.query.tenantId, request.query.chargingCalloutRef, owner(request, request.query.tenantId));
    if (!receipt) return reply.code(404).send({ error: 'Withdrawal not found' });
    return receipt;
  }
}
