// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { AbstractModule, childLogger, type ICache } from '@citrineos/base';
import type { SystemConfig } from '@citrineos/types';
import { OidcTokenProvider } from '@/apis/index.js';
import type { ILogObj, Logger } from 'tslog';

/**
 * Completes an API command: when a caller supplied a callback URL with a request, this POSTs the
 * station's answer back to it.
 */
export class CallbackUrlNotifier {
  private readonly _cache: ICache;
  private readonly _logger: Logger<ILogObj>;
  private readonly _oidcTokenProvider?: OidcTokenProvider;

  constructor({
    cache,
    config,
    logger,
  }: {
    cache: ICache;
    config?: SystemConfig;
    logger?: Logger<ILogObj>;
  }) {
    this._cache = cache;
    this._logger = childLogger(logger, this.constructor.name);

    if (config?.oidcClient) {
      this._oidcTokenProvider = new OidcTokenProvider(config.oidcClient, this._logger);
    }
  }

  async notify(correlationId: string, ocppConnectionName: string, payload: any): Promise<void> {
    const url: string | null = await this._cache.remove<string>(
      correlationId,
      AbstractModule.CALLBACK_URL_CACHE_PREFIX + ocppConnectionName,
    );
    if (!url) return;

    this._logger.debug(`Sending callback to ${url} for correlationId: ${correlationId}`);

    const headers: { [key: string]: string } = { 'Content-Type': 'application/json' };

    if (this._oidcTokenProvider) {
      try {
        const token = await this._oidcTokenProvider.getToken();
        headers['Authorization'] = `Bearer ${token}`;
      } catch (error) {
        this._logger.error('Failed to get OIDC token for callback:', error);
        return;
      }
    }

    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, { method: `POST`, headers, body });
        if (response.ok) return;

        const errorText = await response.text();
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        this._logger.error(
          `Callback to ${url} failed (attempt ${attempt}): ${response.status} ${response.statusText} - ${errorText}`,
        );
        if (!retryable) return;
      } catch (error) {
        this._logger.error(`Callback to ${url} failed (attempt ${attempt}):`, error);
      }

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }
}
