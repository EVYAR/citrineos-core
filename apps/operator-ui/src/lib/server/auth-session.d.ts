// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface User {
    roles?: string[];
  }
  interface Session {
    user?: DefaultSession['user'] & { roles?: string[]; tenantId?: string; sub?: string };
    accessToken?: string;
    error?: string;
  }
}
