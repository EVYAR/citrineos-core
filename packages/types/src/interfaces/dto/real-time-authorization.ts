// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { IdTokenEnumType } from './types/enums.js';

export interface RealTimeAuthorizationRequestBody {
  tenantPartnerId?: number | null;
  idToken: string;
  idTokenType: IdTokenEnumType;
  locationId?: string;
  ocppConnectionName: string;
  evseId?: number;
  connectorId?: number;
  targetSource?: 'EXPLICIT' | 'INFERRED_SINGLE_CONNECTOR' | 'NONE';
  ocppEvseId?: number;
  ocppConnectorId?: number;
  chargingCalloutRef?: string;
}

export interface RealTimeAuthorizationResponse {
  timestamp: string;
  data: {
    allowed: string;
    reason?: string;
  };
}
