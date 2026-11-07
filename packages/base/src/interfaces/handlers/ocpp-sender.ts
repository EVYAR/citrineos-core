// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { serializeError } from '@base-util/errors.js';
import { createIdentifier } from '@base-util/identifiers.js';
import { childLogger, loggerDefaults } from '@base-util/logging.js';
import { RequestBuilder } from '@base-util/request.js';
import {
  ErrorCode,
  type CallAction,
  OCPPVersion,
  type OcppRequest,
  type OcppResponse,
  type SystemConfig,
} from '@citrineos/types';
import type { ICache } from '@interfaces/cache/cache.js';
import { CacheNamespace, type IWebsocketConnection } from '@interfaces/cache/types.js';
import type { IOcppSender, SendCallArgs } from '@interfaces/handlers/i-ocpp-sender.js';
import {
  type IMessage,
  type IMessageConfirmation,
  type IMessageSender,
  MessageOrigin,
} from '@interfaces/messages/index.js';
import { OCPPValidator } from '@interfaces/modules/ocpp-validator.js';
import { OcppError } from '@ocpp/rpc/message.js';
import type { ILogObj, Logger } from 'tslog';
import { v4 as uuidv4 } from 'uuid';

/**
 * OcppSender is primarily for abstracting any OCPP message calls that
 * {@link AbstractHandler}s may use when processing OCPP messages.
 */
export class OcppSender implements IOcppSender {
  private readonly CALLBACK_URL_CACHE_PREFIX: string = 'CALLBACK_URL_';

  protected _config: SystemConfig;
  protected _ocppValidator: OCPPValidator;
  protected readonly _cache: ICache;
  protected readonly _sender: IMessageSender;
  protected readonly _logger: Logger<ILogObj>;

  constructor({
    config,
    cache,
    sender,
    logger,
    ocppValidator,
  }: {
    config: SystemConfig;
    cache: ICache;
    sender: IMessageSender;
    logger?: Logger<ILogObj>;
    ocppValidator?: OCPPValidator;
  }) {
    this._config = config;
    this._logger = this._initLogger(logger);
    this._ocppValidator = ocppValidator ? ocppValidator : new OCPPValidator(logger);
    this._logger.info('Initializing OcppSender...');
    this._sender = sender;
    this._cache = cache;
  }

  /**
   * Sends a call with the specified identifier, tenantId, protocol, action, payload, and origin.
   *
   * @return {Promise<IMessageConfirmation>} A promise that resolves to the message confirmation.
   */
  public async sendCall({
    ocppConnectionName,
    tenantId,
    protocol,
    action,
    eventGroup,
    payload,
    callbackUrl,
    correlationId,
    staleAfterSeconds,
    origin = MessageOrigin.ChargingStationManagementSystem,
  }: SendCallArgs): Promise<IMessageConfirmation> {
    const identifier = createIdentifier(tenantId, ocppConnectionName);
    const _correlationId: string = correlationId === undefined ? uuidv4() : correlationId;

    payload = this._ocppValidator.sanitizeOCPPPayload(payload);
    const { isValid, errors } = this._ocppValidator.validateOCPPRequest(
      action,
      payload,
      protocol as OCPPVersion,
    );

    if (!isValid || errors) {
      throw new OcppError(_correlationId, ErrorCode.FormatViolation, 'Invalid message format', {
        errors: errors,
      });
    }

    if (callbackUrl) {
      // The callback registration is part of dispatch correctness. Await it before
      // sending so a fast charger CallResult cannot race an uncommitted cache write.
      this._logger.debug(
        `Setting callback URL: ${callbackUrl} for correlationId: ${_correlationId}`,
      );
      try {
        const stored = await this._cache.set(
          _correlationId,
          callbackUrl,
          this.CALLBACK_URL_CACHE_PREFIX + ocppConnectionName,
          this._config.timeouts.maxCachingSeconds,
        );
        if (!stored) {
          this._logger.error(`Failed to set callback cache for correlationId: ${_correlationId}`);
          return this._commandFailureConfirmation(
            _correlationId,
            action,
            'CALLBACK_REGISTRATION_FAILED',
            'CALLBACK_CACHE_REJECTED',
            'Unable to register the command callback before dispatch',
          );
        }
      } catch (error) {
        this._logger.error(
          `Error setting callback cache for correlationId: ${_correlationId}`,
          error,
        );
        return this._commandFailureConfirmation(
          _correlationId,
          action,
          'CALLBACK_REGISTRATION_FAILED',
          'CALLBACK_CACHE_ERROR',
          'Unable to register the command callback before dispatch',
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    // TODO: Future - Compound key with tenantId
    return this._cache
      .get<string>(identifier, CacheNamespace.Connections)
      .then(async (connection) => {
        if (connection) {
          const websocketConnection: IWebsocketConnection = JSON.parse(connection);
          if (websocketConnection.protocol !== protocol) {
            this._logger.error(
              `Failed sending call. Requested protocol: '${protocol}', connection protocol: '${websocketConnection.protocol}' for identifier: `,
              identifier,
            );
            if (callbackUrl) {
              await this._cache.remove(
                _correlationId,
                this.CALLBACK_URL_CACHE_PREFIX + ocppConnectionName,
              );
            }
            return Promise.resolve(
              this._commandFailureConfirmation(
                _correlationId,
                action,
                'DISPATCH_FAILED',
                'PROTOCOL_MISMATCH',
                `Requested protocol: '${protocol}', connection protocol: '${websocketConnection.protocol}' for identifier: '${identifier}'`,
              ),
            );
          }
          const call = RequestBuilder.buildCall(
            ocppConnectionName,
            _correlationId,
            tenantId,
            action,
            payload,
            eventGroup,
            origin,
            protocol,
          );
          if (staleAfterSeconds !== undefined) call.context.staleAfterSeconds = staleAfterSeconds;
          return this._sender.sendRequest(call);
        } else {
          // Forward the request so the router owns the terminal dispatch decision and
          // can deliver the correlated DISPATCH_FAILED callback. Its network hook
          // is the authoritative connection check.
          this._logger.warn(
            'No module-side connection cache entry; forwarding call to the router: ',
            identifier,
          );
          const call = RequestBuilder.buildCall(
            ocppConnectionName,
            _correlationId,
            tenantId,
            action,
            payload,
            eventGroup,
            origin,
            protocol,
          );
          if (staleAfterSeconds !== undefined) call.context.staleAfterSeconds = staleAfterSeconds;
          return this._sender.sendRequest(call);
        }
      });
  }

  /**
   * Sends the call result using the request message's fields.
   * Payload will overwrite message.payload.
   *
   * @param {IMessage<OcppRequest>} message - The request message object.
   * @param {OcppResponse} payload - The payload to send.
   * @return {Promise<IMessageConfirmation>} A promise that resolves to the message confirmation.
   */
  public sendCallResultWithMessage(
    message: IMessage<OcppRequest>,
    payload: OcppResponse,
  ): Promise<IMessageConfirmation> {
    payload = this._ocppValidator.sanitizeOCPPPayload(payload);
    const { isValid, errors } = this._ocppValidator.validateOCPPResponse(
      message.action,
      payload,
      message.protocol as OCPPVersion,
    );

    if (!isValid || errors) {
      throw new OcppError(
        message.context.correlationId,
        ErrorCode.FormatViolation,
        'Invalid message format',
        {
          errors: errors,
        },
      );
    }

    if (this._stationStoppedWaiting(message)) {
      return Promise.resolve({
        success: false,
        payload: 'The station stopped waiting for this response',
      });
    }
    message.origin = MessageOrigin.ChargingStationManagementSystem;
    message.context = { ...message.context, timestamp: new Date().toISOString() };
    return this._sender.sendResponse(message, payload);
  }

  /**
   * Sends the call error using the request message's fields.
   * Payload will overwrite message.payload.
   *
   * @param {IMessage<OcppRequest>} message - The request message object.
   * @param {OcppResponse} payload - The payload to send.
   * @return {Promise<IMessageConfirmation>} A promise that resolves to the message confirmation.
   */
  public sendCallErrorWithMessage(
    message: IMessage<OcppRequest>,
    payload: OcppError,
  ): Promise<IMessageConfirmation> {
    if (this._stationStoppedWaiting(message)) {
      return Promise.resolve({
        success: false,
        payload: 'The station stopped waiting for this response',
      });
    }
    message.origin = MessageOrigin.ChargingStationManagementSystem;
    message.context = { ...message.context, timestamp: new Date().toISOString() };
    return this._sender.sendResponse(message, payload);
  }

  /**
   * True once `request`, a station's Call, is older than maxCallLengthSeconds: the station has
   * timed it out, and the router would reject a response to it. The Call itself is still
   * processed; only the response is not sent.
   */
  private _commandFailureConfirmation(
    correlationId: string,
    action: CallAction,
    outcome: 'CALLBACK_REGISTRATION_FAILED' | 'DISPATCH_FAILED',
    code: string,
    description: string,
    details: object = {},
  ): IMessageConfirmation {
    return {
      success: false,
      payload: {
        success: false,
        outcome,
        correlationId,
        action,
        error: { code, description, details },
      },
    };
  }

  private _stationStoppedWaiting(request: IMessage<OcppRequest>): boolean {
    const ageMs = Date.now() - new Date(request.context.timestamp).getTime();
    if (ageMs <= this._config.timeouts.maxCallLengthSeconds * 1000) {
      return false;
    }
    this._logger.info(
      `Not responding to ${request.action} from ${request.context.ocppConnectionName}: the Call ` +
        `arrived ${ageMs} ms ago, past maxCallLengthSeconds. correlationId=${request.context.correlationId}`,
    );
    return true;
  }

  /**
   * Initializes the logger for the class.
   *
   * @return {Logger<ILogObj>} The initialized logger.
   */
  protected _initLogger(baseLogger?: Logger<ILogObj>): Logger<ILogObj> {
    return childLogger(baseLogger, this.constructor.name, () => ({
      ...loggerDefaults(this._config.env),
      minLevel: this._config.logLevel,
    }));
  }
}
