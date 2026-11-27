// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { AbstractModule, childLogger, createIdentifier, type ICache } from '@citrineos/base';
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

  async notify(
    tenantId: number,
    correlationId: string,
    ocppConnectionName: string,
    payload: unknown,
  ): Promise<void> {
    const url: string | null = await this._cache.remove<string>(
      correlationId,
      AbstractModule.CALLBACK_URL_CACHE_PREFIX + createIdentifier(tenantId, ocppConnectionName),
    );
    if (!url) return;

    this._logger.debug('Sending callback', { correlationId });
    const deadline = Date.now() + 15_000;

    const headers: { [key: string]: string } = { 'Content-Type': 'application/json' };

    if (this._oidcTokenProvider) {
      try {
        const token = await this.withDeadline(this._oidcTokenProvider.getToken(), deadline);
        headers['Authorization'] = `Bearer ${token}`;
      } catch {
        this._logger.error('Failed to get OIDC token for callback');
        return;
      }
    }

    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      try {
        const response = await this.withDeadline(
          fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            redirect: 'error',
          }).then((response) => {
            // No response body is needed, including on failure.
            void response.body?.cancel().catch(() => undefined);
            return response;
          }),
          Math.min(deadline, Date.now() + 5_000),
          controller,
        );
        if (response.ok) return;
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        this._logger.error('Callback HTTP failure', { attempt, status: response.status });
        if (!retryable) return;
      } catch {
        this._logger.error('Callback transport failure', { attempt });
      } finally {
        controller.abort();
      }

      if (Date.now() >= deadline) return;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    controller?: AbortController,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller?.abort();
              reject(new Error('Callback deadline exceeded'));
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
