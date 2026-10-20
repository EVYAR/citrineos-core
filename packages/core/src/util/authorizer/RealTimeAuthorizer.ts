// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import {
  AuthorizationStatusEnum,
  AuthorizationWhitelistEnum,
  type AuthorizationStatusEnumType,
  type ConnectorDto,
  type EvseDto,
  type IAuthorizer,
  type IdTokenEnumType,
  type IMessageContext,
  type SystemConfig,
} from '@citrineos/base';
import type { ILocationRepository } from '@dal/interfaces/repositories.js';
import type { Authorization } from '@dal/layers/sequelize/index.js';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';
import { OidcTokenProvider } from '../authorization/index.js';
import { ChargingCalloutDeclineNotifier } from './ChargingCalloutDeclineNotifier.js';
import { type ChargingCalloutStore, newCoreEvidenceRef } from './ChargingCalloutLedger.js';

export interface RealTimeAuthorizationRequestBody {
  tenantPartnerId?: number | null;
  idToken: string;
  idTokenType: IdTokenEnumType;
  locationId?: string;
  ocppConnectionName: string;
  /** Core database ids (kept for compatibility). */
  evseId?: number;
  connectorId?: number;
  /**
   * How `evseId`/`connectorId` were obtained. EXPLICIT: the message named the connector/EVSE (OCPP 1.6
   * StartTransaction, OCPP 2.x TransactionEvent Started). INFERRED_SINGLE_CONNECTOR: the station has exactly one
   * connector and none was named (a bare Authorize); that is a guess and must not be treated as a start target.
   * NONE: no target. Absent on older Core versions.
   */
  targetSource?: 'EXPLICIT' | 'INFERRED_SINGLE_CONNECTOR' | 'NONE';
  /** OCPP protocol identifiers of the EXPLICIT target (1.6: evse = connector = connectorId). */
  ocppEvseId?: number;
  ocppConnectorId?: number;
  /**
   * Core-generated durable reference of this exact callout (CGP-0012). Present only for EXPLICIT targets when charging
   * callouts are enabled; pinned before the callout and reused on retries of the same request.
   */
  chargingCalloutRef?: string;
}

export interface RealTimeAuthorizationResponse {
  timestamp: string;
  data: {
    allowed: string;
    reason?: string;
  };
}

export class RealTimeAuthorizer implements IAuthorizer {
  private _locationRepository: ILocationRepository;
  private _config: SystemConfig;
  private readonly _logger: Logger<ILogObj>;
  private readonly _oidcTokenProvider?: OidcTokenProvider;
  private readonly _calloutStore?: ChargingCalloutStore;
  private readonly _declineNotifier?: ChargingCalloutDeclineNotifier;

  constructor(dependencies: {
    locationRepository: ILocationRepository;
    config: SystemConfig;
    logger: Logger<ILogObj>;
    chargingCalloutStore?: ChargingCalloutStore;
    /** Test seam; production builds the notifier from `realTimeAuthChargingCallouts`. */
    declineNotifier?: ChargingCalloutDeclineNotifier;
  }) {
    const { locationRepository, config, logger } = dependencies;
    // Optional dependencies are read defensively: a DI container that does not register them (other apps, older wiring)
    // makes the proxy throw on access, which must simply mean "feature unavailable", not a failed Core start.
    const optional = <T>(read: () => T | undefined): T | undefined => {
      try {
        return read();
      } catch {
        return undefined;
      }
    };
    const chargingCalloutStore = optional(() => dependencies.chargingCalloutStore);
    const declineNotifier = optional(() => dependencies.declineNotifier);
    this._locationRepository = locationRepository;
    this._config = config;
    this._logger = logger.getSubLogger({ name: this.constructor.name });
    if (config.oidcClient) {
      this._oidcTokenProvider = new OidcTokenProvider(config.oidcClient, this._logger);
    }
    const callouts = config.realTimeAuthChargingCallouts;
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
    authorization: Authorization,
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
    let requiresLiveTarget = Boolean(this._calloutStore && (evse || connector));
    try {
      const chargingStation = await this._locationRepository.readChargingStationByStationId(
        context.tenantId,
        context.ocppConnectionName,
      );

      // Determine evseId and connectorId
      // Priority: provided evse and connector > provided evse with single connector > station with single evse and single connector
      if (evse && connector) {
        evseId = evse.id!;
        connectorId = connector.id!;
        targetSource = 'EXPLICIT';
        ocppConnectorId = connector.connectorId;
        ocppEvseId = evse.evseTypeId ?? connector.connectorId;
      } else if (evse && !connector && evse.connectors?.length === 1) {
        evseId = evse.id!;
        connectorId = evse.connectors[0].id!;
        targetSource = 'EXPLICIT';
        ocppConnectorId = evse.connectors[0].connectorId;
        ocppEvseId = evse.evseTypeId ?? evse.connectors[0].connectorId;
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
            authorization.realTimeAuthTimeout ?? this._config.realTimeAuthDefaultTimeoutSeconds;
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
          (this._config.realTimeAuthRequestTimeoutMs ?? 3000) * 2,
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

      if (this._oidcTokenProvider) {
        try {
          const token = await this._oidcTokenProvider.getToken();
          headers['Authorization'] = `Bearer ${token}`;
        } catch (error) {
          this._logger.error('Failed to get OIDC token:', error);
          return AuthorizationStatusEnum.Invalid;
        }
      }

      const response = await fetch(authorization.realTimeAuthUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this._config.realTimeAuthRequestTimeoutMs ?? 3000),
      });

      if ('ok' in response && !response.ok) {
        throw new Error(`Realtime Auth returned HTTP ${response.status}`);
      }

      const responseJson = await response.json();

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
        !requiresLiveTarget
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
    await authorization.save().catch((error) => {
      this._logger.error(
        `Failed to save realTimeAuthLastAttempt for authorization ${authorization.id}: ${error}`,
      );
    });

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
