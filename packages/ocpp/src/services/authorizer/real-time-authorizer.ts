// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { OidcTokenProvider } from '@/apis/index.js';
import { type IAuthorizer, type IMessageContext } from '@citrineos/base';
import type { IAuthorizationRepository, IChargingStationRepository } from '@citrineos/dal';
import {
  type AuthorizationDto,
  AuthorizationStatusEnum,
  type AuthorizationStatusEnumType,
  AuthorizationWhitelistEnum,
  type ConnectorDto,
  type EvseDto,
  type RealTimeAuthorizationRequestBody,
  type RealTimeAuthorizationResponse,
  type SystemConfig,
} from '@citrineos/types';
import { ChargingCalloutDeclineNotifier } from './ChargingCalloutDeclineNotifier.js';
import { type ChargingCalloutStore, newCoreEvidenceRef } from './ChargingCalloutLedger.js';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';

/** A timed-out waiter must not cancel a shared OIDC request used by another caller. */
function beforeAuthorizationAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export class RealTimeAuthorizer implements IAuthorizer {
  private _chargingStationRepository: IChargingStationRepository;
  private _authorizationRepository: IAuthorizationRepository;
  private _config: SystemConfig;
  private readonly _logger: Logger<ILogObj>;
  private readonly _oidcTokenProvider?: OidcTokenProvider;
  private readonly _calloutStore?: ChargingCalloutStore;
  private readonly _declineNotifier?: ChargingCalloutDeclineNotifier;

  constructor(dependencies: {
    chargingStationRepository: IChargingStationRepository;
    authorizationRepository: IAuthorizationRepository;
    config: SystemConfig;
    logger: Logger<ILogObj>;
    chargingCalloutStore?: ChargingCalloutStore;
    declineNotifier?: ChargingCalloutDeclineNotifier;
  }) {
    const { chargingStationRepository, authorizationRepository, config, logger } = dependencies;
    const optional = <T>(read: () => T | undefined): T | undefined => {
      try {
        return read();
      } catch {
        return undefined;
      }
    };
    const callouts = config.realTimeAuthChargingCallouts;
    const chargingCalloutStore = callouts?.enabled ? dependencies.chargingCalloutStore : undefined;
    if (callouts?.enabled && !chargingCalloutStore) {
      throw new Error('Enabled charging callouts require a durable chargingCalloutStore');
    }
    const declineNotifier = optional(() => dependencies.declineNotifier);
    this._chargingStationRepository = chargingStationRepository;
    this._authorizationRepository = authorizationRepository;
    this._config = config;
    this._logger = logger.getSubLogger({ name: this.constructor.name });
    if (config.oidcClient) {
      this._oidcTokenProvider = new OidcTokenProvider(config.oidcClient, this._logger);
    }
    if (callouts?.enabled && chargingCalloutStore) {
      this._calloutStore = chargingCalloutStore;
      this._declineNotifier =
        declineNotifier ??
        new ChargingCalloutDeclineNotifier(chargingCalloutStore, callouts, this._logger);
      this._declineNotifier.start();
    }
  }

  async shutdown(): Promise<void> {
    await this._declineNotifier?.shutdown();
  }

  async authorize(
    authorization: AuthorizationDto,
    context: IMessageContext,
    evse?: EvseDto,
    connector?: ConnectorDto,
  ): Promise<AuthorizationStatusEnumType> {
    if (!authorization.realTimeAuthUrl) {
      this._logger.debug(`No Realtime Auth URL from authorization ${authorization.id}`);
      return authorization.status;
    } else if (
      !authorization.realTimeAuth ||
      authorization.realTimeAuth === AuthorizationWhitelistEnum.Allowed
    ) {
      this._logger.debug(`Realtime Auth whitelisted for authorization ${authorization.id}`);
      return authorization.status;
    } else if (authorization.status !== AuthorizationStatusEnum.Accepted) {
      this._logger.debug(
        `Skipping Realtime Auth for authorization ${authorization.id} with status ${authorization.status}`,
      );
      return authorization.status;
    }

    let evseId = undefined;
    let connectorId = undefined;
    let targetSource: RealTimeAuthorizationRequestBody['targetSource'] = 'NONE';
    let ocppEvseId: number | undefined = undefined;
    let ocppConnectorId: number | undefined = undefined;
    let result: AuthorizationStatusEnumType = AuthorizationStatusEnum.Invalid;
    let chargingCalloutRef: string | undefined;
    let oidcFailed = false;
    let requiresLiveTarget = Boolean(
      this._calloutStore && (evse || connector || context.requiresExplicitAuthorizationTarget),
    );
    try {
      const chargingStation =
        await this._chargingStationRepository.readChargingStationByOcppConnectionName(
          context.tenantId,
          context.ocppConnectionName,
        );

      // Determine evseId and connectorId
      // Priority: provided evse and connector > provided evse with single connector > station with single evse and single connector
      if (evse && connector) {
        evseId = evse.id!;
        connectorId = connector.id!;
        targetSource = 'EXPLICIT';
        ocppConnectorId = connector.evseTypeConnectorId ?? connector.connectorId ?? undefined;
        ocppEvseId = evse.evseTypeId ?? connector.connectorId ?? undefined;
      } else if (evse && !connector && evse.connectors?.length === 1) {
        evseId = evse.id!;
        connectorId = evse.connectors[0].id!;
        targetSource = 'EXPLICIT';
        ocppConnectorId =
          evse.connectors[0].evseTypeConnectorId ?? evse.connectors[0].connectorId ?? undefined;
        ocppEvseId = evse.evseTypeId ?? evse.connectors[0].connectorId ?? undefined;
      } else if (
        chargingStation &&
        chargingStation.evses &&
        chargingStation.evses.length === 1 &&
        chargingStation.evses[0].connectors?.length === 1
      ) {
        evseId = chargingStation.evses[0].id!;
        connectorId = chargingStation.evses[0].connectors![0].id!;
        targetSource = 'INFERRED_SINGLE_CONNECTOR';
      }

      // A connector start must claim/check its durable fence and current package authority.
      // A recent Authorize answer cannot stand in for this explicit physical-start decision.
      requiresLiveTarget ||= Boolean(
        this._calloutStore &&
          targetSource === 'EXPLICIT' &&
          connectorId !== undefined &&
          authorization.id !== undefined,
      );
      if (
        requiresLiveTarget &&
        (targetSource !== 'EXPLICIT' || connectorId === undefined || authorization.id === undefined)
      ) {
        throw new Error('Explicit charging target cannot be durably fenced');
      }
      if (authorization.realTimeAuthLastAttempt && !requiresLiveTarget) {
        const realTimeAuthLastAttempt = authorization.realTimeAuthLastAttempt;
        // Check if last attempt was at the same station and connector within the timeout period
        if (
          (this._config.realTimeAuthReplayLastAttempt ?? true) &&
          context.ocppConnectionName === realTimeAuthLastAttempt.ocppConnectionName &&
          connectorId === realTimeAuthLastAttempt.connectorId
        ) {
          const lastAttempt = new Date(realTimeAuthLastAttempt.timestamp);
          const timeout =
            authorization.realTimeAuthTimeout ??
            this._config.timeouts.realTimeAuthDefaultTimeoutSeconds;
          const now = new Date();
          const diffInSeconds = (now.getTime() - lastAttempt.getTime()) / 1000;
          if (diffInSeconds < timeout) {
            this._logger.debug(
              `Skipping Realtime Auth for authorization ${authorization.id} due to timeout (${diffInSeconds}s < ${timeout}s)`,
            );
            return realTimeAuthLastAttempt.result;
          }
        }
      }

      // CGP-0012: target-specific callouts are pinned to a durable Core ref. A request Core already declined before power
      // stays fenced: it is answered declined without a new callout, so a late response can never authorize it.
      if (
        this._calloutStore &&
        targetSource === 'EXPLICIT' &&
        connectorId !== undefined &&
        authorization.id !== undefined
      ) {
        const callouts = this._config.realTimeAuthChargingCallouts!;
        const begun = await this._calloutStore.begin(
          {
            tenantId: context.tenantId,
            ocppConnectionName: context.ocppConnectionName,
            authorizationId: authorization.id,
            connectorId,
          },
          new Date(),
          (this._config.realTimeAuthRequestTimeoutMs ?? 8000) * 2,
          callouts.fenceSeconds * 1000,
        );
        if (begun.kind === 'FENCED_DECLINED') {
          this._logger.warn(
            `Realtime Auth fenced: callout ${begun.ref} was already declined before power`,
          );
          return AuthorizationStatusEnum.Invalid;
        }
        chargingCalloutRef = begun.ref;
      }

      const payload: RealTimeAuthorizationRequestBody = {
        tenantPartnerId: authorization.tenantPartnerId,
        idToken: authorization.idToken,
        idTokenType: authorization.idTokenType!,
        locationId: chargingStation?.locationId?.toString(),
        ocppConnectionName: context.ocppConnectionName,
        ...(evseId !== undefined ? { evseId } : {}),
        ...(connectorId !== undefined ? { connectorId } : {}),
        targetSource,
        ...(ocppEvseId !== undefined ? { ocppEvseId } : {}),
        ...(ocppConnectorId !== undefined ? { ocppConnectorId } : {}),
        ...(chargingCalloutRef ? { chargingCalloutRef } : {}),
      };

      this._logger.debug(
        `Sending Realtime Auth request for authorization ${authorization.id} to url: ${authorization.realTimeAuthUrl}`,
      );

      const headers: { [key: string]: string } = {
        'Content-Type': 'application/json',
      };

      const expiresAt = Date.now() + (this._config.realTimeAuthRequestTimeoutMs ?? 8000);
      const deadline = AbortSignal.timeout(this._config.realTimeAuthRequestTimeoutMs ?? 8000);
      if (this._oidcTokenProvider) {
        try {
          const token = await beforeAuthorizationAbort(
            this._oidcTokenProvider.getToken(),
            deadline,
          );
          headers['Authorization'] = `Bearer ${token}`;
        } catch (error) {
          oidcFailed = true;
          throw error;
        }
      }
      deadline.throwIfAborted();
      const remaining = Math.floor(expiresAt - Date.now()) - 50;
      if (remaining <= 0) throw new Error('Real-Time Auth deadline exceeded');
      headers['x-evyar-request-budget-ms'] = String(remaining);
      const response = await beforeAuthorizationAbort(
        fetch(authorization.realTimeAuthUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: deadline,
        }),
        deadline,
      );

      if ('ok' in response && !response.ok) {
        throw new Error(`Realtime Auth returned HTTP ${response.status}`);
      }

      const responseJson = await beforeAuthorizationAbort(response.json(), deadline);
      deadline.throwIfAborted();
      if (Date.now() >= expiresAt) throw new Error('Real-Time Auth deadline exceeded');

      const realTimeAuth: RealTimeAuthorizationResponse =
        responseJson as RealTimeAuthorizationResponse;
      const allowed = realTimeAuth?.data?.allowed;
      this._logger.debug(`Real time auth response: ${allowed ?? 'MALFORMED'}`);
      if (allowed) {
        switch (allowed) {
          case 'ALLOWED':
            result = AuthorizationStatusEnum.Accepted;
            break;
          case 'BLOCKED':
            result = AuthorizationStatusEnum.Blocked;
            break;
          case 'EXPIRED':
            result = AuthorizationStatusEnum.Expired;
            break;
          case 'NO_CREDIT':
            result = AuthorizationStatusEnum.NoCredit;
            break;
          case 'NOT_ALLOWED':
            result = AuthorizationStatusEnum.NotAtThisLocation;
            break;
          default:
            result = AuthorizationStatusEnum.Unknown;
        }
      } else {
        result = AuthorizationStatusEnum.Unknown;
      }
    } catch (error) {
      this._logger.error(`Real-Time Auth failed: ${error}`);
      if (
        authorization.realTimeAuth === AuthorizationWhitelistEnum.AllowedOffline &&
        !requiresLiveTarget &&
        !oidcFailed
      ) {
        result = AuthorizationStatusEnum.Accepted;
      }
    }

    if (this._calloutStore && chargingCalloutRef) {
      result = await this.commitCalloutDecision(chargingCalloutRef, result);
    }

    authorization.realTimeAuthLastAttempt = {
      timestamp: new Date().toISOString(),
      result,
      ocppConnectionName: context.ocppConnectionName,
      evseId: evseId,
      ...(connectorId !== undefined ? { connectorId } : {}),
    };

    try {
      await this._authorizationRepository.updateByKey(
        context.tenantId,
        authorization,
        String(authorization.id!),
      );
    } catch (error) {
      this._logger.error(
        `Failed to save realTimeAuthLastAttempt for authorization ${authorization.id}: ${error}`,
      );
    }

    return result;
  }

  /**
   * Durably commits the outcome of a pinned callout BEFORE Core answers the charger.
   * - Accepted: PENDING -> AUTHORIZED. If the request was already fenced as declined, a late acceptance must not power: Invalid.
   * - Anything else (declined, timeout, transport failure, malformed or unknown answer): PENDING -> DECLINED_BEFORE_POWER with a
   *   durable evidence ref, then the decline receipt is delivered to the adapter by the retrying notifier. If the ledger cannot
   *   be written, the answer is still declined (fail closed) and no receipt is emitted, so the adapter keeps the slot held.
   */
  private async commitCalloutDecision(
    ref: string,
    result: AuthorizationStatusEnumType,
  ): Promise<AuthorizationStatusEnumType> {
    const store = this._calloutStore!;
    const now = new Date();
    if (result === AuthorizationStatusEnum.Accepted) {
      try {
        if (await store.markAuthorized(ref, now)) return result;
      } catch (error) {
        this._logger.error(`Could not record authorization of callout ${ref}: ${error}`);
      }
      this._logger.warn(
        `Callout ${ref} was no longer pending: a late acceptance cannot authorize power`,
      );
      return AuthorizationStatusEnum.Invalid;
    }
    try {
      if (await store.markDeclined(ref, newCoreEvidenceRef(), now)) {
        void this._declineNotifier
          ?.flush()
          .catch((error) => this._logger.error(`decline flush failed: ${error}`));
      }
    } catch (error) {
      this._logger.error(
        `Could not durably decline callout ${ref}; no receipt will be emitted: ${error}`,
      );
    }
    return result;
  }
}

export default RealTimeAuthorizer;
