// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';

export interface OidcTokenProviderConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
}

interface OidcToken {
  accessToken: string;
  expiresAt: number;
}

/** This owner timer bounds transport work; individual callers only cancel their own wait. */
function beforeTokenAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
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

export class OidcTokenProvider {
  private oidcToken?: OidcToken;
  private readonly _logger: Logger<ILogObj>;

  constructor(
    private config: OidcTokenProviderConfig,
    logger?: Logger<ILogObj>,
  ) {
    this._logger = logger
      ? logger.getSubLogger({ name: this.constructor.name })
      : new Logger<ILogObj>({ name: this.constructor.name });
  }

  public async getToken(): Promise<string> {
    if (this.oidcToken && this.oidcToken.expiresAt > Date.now()) {
      this._logger.debug('Returning cached OIDC token');
      return this.oidcToken.accessToken;
    }

    this._logger.debug('Fetching new OIDC token');
    const expiresAt = Date.now() + 8000;
    const deadline = AbortSignal.timeout(8000);
    const response = await beforeTokenAbort(
      fetch(this.config.tokenUrl, {
        method: 'POST',
        signal: deadline,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          audience: this.config.audience,
        }),
      }),
      deadline,
    );

    if (!response.ok) {
      const errorText = await beforeTokenAbort(response.text(), deadline);
      deadline.throwIfAborted();
      if (Date.now() >= expiresAt) throw new Error('OIDC transport deadline exceeded');
      this._logger.error('Failed to fetch OIDC token:', errorText);
      throw new Error(`Failed to fetch OIDC token: ${response.statusText}`);
    }

    const tokenData = await beforeTokenAbort(response.json(), deadline);
    deadline.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('OIDC transport deadline exceeded');
    this.oidcToken = {
      accessToken: tokenData.access_token,
      // Set expiry to 1 minute before actual expiration to be safe
      expiresAt: Date.now() + (tokenData.expires_in - 60) * 1000,
    };

    return this.oidcToken.accessToken;
  }
}
