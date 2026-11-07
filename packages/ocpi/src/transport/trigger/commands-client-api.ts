// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { BaseClientApi, MissingRequiredParamException } from './base-client-api.js';
import type { OcpiEmptyResponse } from '../../types/ocpi-empty-response.js';
import { OcpiEmptyResponseSchema } from '../../types/ocpi-empty-response.js';
import { ModuleId } from '../../types/module-id.js';
import type { ICache } from '@citrineos/base';
import { type TenantPartnerDto } from '@citrineos/types';
import { OcpiResponseStatusCode } from '../../types/ocpi-response.js';
import type { CommandResult } from '../../types/command-result.js';
import {
  COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
  COMMAND_RESPONSE_URL_CACHE_RESOLVED,
} from '../../util/consts.js';
import type { CacheWrapper } from '../../util/cache-wrapper.js';
import type {
  OcpiClientApiDependencies,
  OcpiConfiguredDependencies,
} from '../../server/dependencies.js';

export interface CommandsClientApiDependencies
  extends OcpiClientApiDependencies,
    OcpiConfiguredDependencies {
  cacheWrapper: CacheWrapper;
}

export class CommandsClientApi extends BaseClientApi {
  protected cache: ICache;
  private readonly commandTimeoutSeconds: number;

  constructor(dependencies: CommandsClientApiDependencies) {
    super(dependencies);
    this.cache = dependencies.cacheWrapper.cache;
    this.commandTimeoutSeconds = dependencies.config.commands.timeout;
  }

  CONTROLLER_PATH = ModuleId.Commands;

  getUrl(): string {
    throw new MissingRequiredParamException(`url must be provided by command`);
  }

  async postCommandResult(
    tenantPartner: TenantPartnerDto,
    url: string, // Provided in the command
    body: CommandResult,
    commandId: string,
  ): Promise<OcpiEmptyResponse> {
    // The claim records the terminal choice before delivery, including failed deliveries.
    if (
      !(await this.cache.setIfNotExist(
        commandId,
        body.result,
        'ocpi-command-terminal-v1',
        this.commandTimeoutSeconds * 2,
      ))
    )
      return { status_code: OcpiResponseStatusCode.GenericSuccessCode, timestamp: new Date() };
    await this.cache.set(
      commandId,
      COMMAND_RESPONSE_URL_CACHE_RESOLVED,
      COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
      this.commandTimeoutSeconds,
    );

    const tenant = tenantPartner.tenant;
    const profile = tenantPartner.partnerProfileOCPI;
    if (
      !tenant?.countryCode ||
      !tenant.partyId ||
      !tenantPartner.countryCode ||
      !tenantPartner.partyId ||
      !profile
    )
      throw new Error('Command result owner is incomplete');
    const headers = this.getHeaders(profile);
    headers['OCPI-from-country-code'] = tenant.countryCode;
    headers['OCPI-from-party-id'] = tenant.partyId;
    headers['OCPI-to-country-code'] = tenantPartner.countryCode;
    headers['OCPI-to-party-id'] = tenantPartner.partyId;
    headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deliver = async (): Promise<OcpiEmptyResponse> => {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Command result deadline exceeded');
      }
      if (!response.ok) throw new Error('Command result HTTP failure');
      reader = response.body?.getReader();
      if (!reader) throw new Error('Command result body is missing');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 65_536) throw new Error('Command result response is too large');
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = OcpiEmptyResponseSchema.parse(decoded);
      return result;
    };
    try {
      return await Promise.race([
        deliver(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Command result deadline exceeded'));
          }, 5_000);
        }),
      ]);
    } catch {
      throw new Error('Command result delivery failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => undefined);
      else void response?.body?.cancel().catch(() => undefined);
    }
  }
}
