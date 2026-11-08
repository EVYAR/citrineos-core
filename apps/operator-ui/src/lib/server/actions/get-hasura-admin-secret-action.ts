// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use server';

import type { ActionResult } from '@lib/utils/action-guard';

export async function getHasuraAdminSecretAction(): Promise<ActionResult<string>> {
  return { success: false, code: 'FORBIDDEN', error: 'Browser Hasura credentials are disabled' };
}
