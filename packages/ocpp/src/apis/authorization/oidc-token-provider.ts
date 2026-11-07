// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { ILogObj, Logger } from 'tslog';

import { childLogger } from '@citrineos/base';
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
    work.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

export class OidcTokenProvider {
  private oidcToken?: OidcToken;
  private readonly _logger: Logger<ILogObj>;

  constructor(
    private config: OidcTokenProviderConfig,
    logger?: Logger<ILogObj>,
  ) {
    this._logger = childLogger(logger, this.constructor.name);
  }

  public async getToken(): Promise<string> {
    if (this.oidcToken && this.oidcToken.expiresAt > Date.now()) {
      this._logger.debug('Returning cached OIDC token');
      return this.oidcToken.accessToken;
    }

    this._logger.debug('Fetching new OIDC token');
    const expiresAt = Date.now() + 8000;
    const deadline = AbortSignal.timeout(8000);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      if (reader) void reader.cancel().catch(() => undefined);
      else if (response) void response.body?.cancel().catch(() => undefined);
    };
    deadline.addEventListener('abort', cancel, { once: true });
    try {
      response = await beforeTokenAbort(
        fetch(this.config.tokenUrl, {
          method: 'POST',
          signal: deadline,
          redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            audience: this.config.audience,
          }),
        }).then((received) => {
          if (deadline.aborted) void received.body?.cancel().catch(() => undefined);
          return received;
        }),
        deadline,
      );
      deadline.throwIfAborted();
      if (!response.ok) throw new Error('OIDC token endpoint rejected request');
      reader = response.body?.getReader();
      if (!reader) throw new Error('OIDC token response is missing');
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await beforeTokenAbort(reader.read(), deadline);
        if (done) break;
        length += value.byteLength;
        if (length > 65_536) throw new Error('OIDC token response exceeds limit');
        chunks.push(value);
      }
      const tokenData: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        typeof tokenData !== 'object' ||
        tokenData === null ||
        !('access_token' in tokenData) ||
        typeof tokenData.access_token !== 'string' ||
        tokenData.access_token.trim().length === 0 ||
        !('expires_in' in tokenData) ||
        typeof tokenData.expires_in !== 'number' ||
        !Number.isFinite(tokenData.expires_in) ||
        tokenData.expires_in <= 0
      )
        throw new Error('Invalid OIDC token response');
      const tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;
      if (!Number.isFinite(tokenExpiresAt)) throw new Error('Invalid OIDC token expiry');
      deadline.throwIfAborted();
      if (Date.now() >= expiresAt) throw new Error('OIDC transport deadline exceeded');
      this.oidcToken = {
        accessToken: tokenData.access_token,
        expiresAt: tokenExpiresAt,
      };
      return this.oidcToken.accessToken;
    } catch {
      this._logger.error('OIDC token request failed');
      if (deadline.aborted || Date.now() >= expiresAt) {
        throw new DOMException('OIDC transport deadline exceeded', 'TimeoutError');
      }
      throw new Error('OIDC token request failed');
    } finally {
      deadline.removeEventListener('abort', cancel);
      cancel();
    }
  }
}
