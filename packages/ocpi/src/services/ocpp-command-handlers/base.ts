// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  CoreMachineTokenProvider,
  validCoreTenant,
  type IMessageConfirmation,
} from '@citrineos/base';
import { type ChargingStationDto, type TenantPartnerDto, OCPPVersion } from '@citrineos/types';
import type { OcpiConfig, StartSession, StopSession, UnlockConnector } from '../../../index.js';
import { CommandResultType } from '../../types/command-result.js';
import { CommandType } from '../../types/command-type.js';
import { ModuleId } from '../../types/module-id.js';
import type { IRequestOptions } from 'typed-rest-client';
import { RestClient } from 'typed-rest-client';
import type { ILogObj, Logger } from 'tslog';
import type { IOcpiGraphqlClient } from '../../transport/graphql/index.js';
import type { CommandsClientApi } from '../../transport/trigger/commands-client-api.js';
import type { OcpiConfiguredDependencies } from '../../server/dependencies.js';
import qs from 'qs';
import { Ajv } from 'ajv';

export interface OcppCommandHandlerDependencies extends OcpiConfiguredDependencies {
  ajv: Ajv;
  ocpiGraphqlClient: IOcpiGraphqlClient;
  commandsClientApi: Pick<CommandsClientApi, 'postCommandResult'>;
}

const machineProviders = new WeakMap<OcpiConfig, CoreMachineTokenProvider>();

function coreMachineProvider(config: OcpiConfig): CoreMachineTokenProvider | undefined {
  if (!config.commands.coreAuth) return undefined;
  if (
    Object.keys(config.commands.coreHeaders ?? {}).some((key) =>
      [
        'authorization',
        'proxy-authorization',
        'cookie',
        'host',
        'x-api-key',
        'x-hasura-admin-secret',
      ].includes(key.toLowerCase()),
    )
  ) {
    throw new Error('Static Core credentials cannot accompany machine authentication');
  }
  let provider = machineProviders.get(config);
  if (!provider) {
    provider = new CoreMachineTokenProvider({
      ...config.commands.coreAuth,
      audience: 'citrineos-core',
      role: 'evyar-ocpi',
      scope: 'citrineos:ocpi:invoke',
    });
    machineProviders.set(config, provider);
  }
  return provider;
}

export abstract class OCPPCommandHandler {
  abstract readonly supportedVersion: OCPPVersion;

  private readonly ajv: Ajv;
  protected readonly logger: Logger<ILogObj>;
  protected readonly ocpiGraphqlClient: IOcpiGraphqlClient;
  protected readonly commandsClientApi: Pick<CommandsClientApi, 'postCommandResult'>;
  protected readonly config: OcpiConfig;

  private restClient: RestClient;
  private readonly machineProvider?: CoreMachineTokenProvider;

  constructor({
    ajv,
    config,
    logger,
    ocpiGraphqlClient,
    commandsClientApi,
  }: OcppCommandHandlerDependencies) {
    this.ajv = ajv;
    this.config = config;
    this.machineProvider = coreMachineProvider(config);
    this.logger = logger;
    this.ocpiGraphqlClient = ocpiGraphqlClient;
    this.commandsClientApi = commandsClientApi;
    this.restClient = new RestClient(`CitrineOS OCPI ${ModuleId.Commands}`);
  }

  abstract sendStartSessionCommand(
    startSession: StartSession,
    tenantPartner: TenantPartnerDto,
    chargingStation: ChargingStationDto,
    commandId: string,
    capability: string,
  ): Promise<void>;

  abstract sendStopSessionCommand(
    stopSession: StopSession,
    tenantPartner: TenantPartnerDto,
    chargingStation: ChargingStationDto,
    commandId: string,
    capability: string,
  ): Promise<void>;

  abstract sendUnlockConnectorCommand(
    unlockConnector: UnlockConnector,
    tenantPartner: TenantPartnerDto,
    chargingStation: ChargingStationDto,
    commandId: string,
    capability: string,
  ): Promise<void>;

  abstract handleAsyncCommandResponse(
    tenantPartner: TenantPartnerDto,
    command: CommandType,
    responseUrl: string,
    response: any,
    commandId: string,
  ): Promise<void>;

  protected async sendOCPPMessage(
    url: string,
    payload: any,
    options: IRequestOptions,
    tenantPartner: TenantPartnerDto,
    responseUrl: string,
    commandId: string,
  ): Promise<void> {
    let response: { statusCode?: number; result?: IMessageConfirmation[] | null };
    try {
      // Necessary because typed-rest-client version >=2.1.0 does not support query params for POST/PUT/PATCH
      const queryParams = options.queryParameters!;
      const parsedQueryParams: string = qs.stringify(queryParams.params);

      if (this.machineProvider) {
        const tenantId = tenantPartner.tenantId;
        if (
          !validCoreTenant(tenantId) ||
          (tenantPartner.tenant?.id != null && tenantPartner.tenant.id !== tenantId) ||
          String(queryParams.params['tenantId']) !== String(tenantId)
        ) {
          throw new Error('Verified Core tenant context is required');
        }
        const target = new URL(url);
        if (target.search || target.hash) throw new Error('Invalid configured Core command URL');
        target.search = parsedQueryParams;
        const result = await this.machineProvider.request(tenantId, target, {
          method: 'POST',
          headers: this.config.commands.coreHeaders,
          body: JSON.stringify(payload),
        });
        const decoded: unknown = result.status === 200 ? JSON.parse(result.body) : undefined;
        const accepted =
          Array.isArray(decoded) &&
          decoded.length > 0 &&
          decoded.every(
            (entry: unknown) =>
              typeof entry === 'object' &&
              entry !== null &&
              'success' in entry &&
              entry.success === true,
          );
        if (result.status === 200 && accepted) return;
        response = { statusCode: result.status };
      } else {
        response = await this.restClient.create<IMessageConfirmation[]>(
          `${url}?${parsedQueryParams}`,
          payload,
          options,
        );
      }
    } catch {
      response = { statusCode: 502 };
    }
    if (response.statusCode !== 200 || !response.result?.[0]?.success) {
      this.logger.warn('Failed to send OCPP request', {
        statusCode: response?.statusCode,
      });
      await this.commandsClientApi.postCommandResult(
        tenantPartner,
        responseUrl,
        {
          result: CommandResultType.FAILED,
          message: {
            language: 'en',
            text: 'Charging station communication failed',
          },
        },
        commandId,
      );
    }
  }

  protected validate<T>(protocol: string, schema: any, data: unknown): T {
    let validate = this.ajv.getSchema(schema['$id']);
    if (!validate) {
      schema['$id'] = `${protocol}-${schema['$id']}`;
      this.logger.debug(`Updated call result schema id: ${schema['$id']}`);
      validate = this.ajv.compile(schema);
    }

    if (!validate(data)) {
      const errors = validate.errors
        ?.map((err: any) => `${err.instancePath} ${err.message}`)
        .join(', ');
      throw new Error(`Validation failed: ${errors}`);
    }

    return data as T;
  }
}
