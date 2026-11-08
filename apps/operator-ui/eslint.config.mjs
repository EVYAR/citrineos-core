// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { FlatCompat } from '@eslint/eslintrc';
import eslintPluginReact from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';
import { sharedConfigs } from '../../eslint.config.base.js';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
  resolvePluginsRelativeTo: dirname(require.resolve('eslint-config-next/package.json')),
});
const nextConfigs = compat.extends('next/core-web-vitals').map((config) => {
  const { useEslintrc, extensions, ...rest } = config;
  return rest;
});

export default tseslint.config(
  ...sharedConfigs,
  ...nextConfigs,
  {
    plugins: {
      react: eslintPluginReact,
    },
    rules: {
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'cypress/no-unnecessary-waiting': 'off',
    },
  },
  {
    files: ['tests/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Playwright fixtures destructure dependencies; an empty pattern
      // is the idiomatic way to declare a fixture with no deps.
      'no-empty-pattern': 'off',
      // Playwright's fixture API receives a `use` parameter; the React
      // hooks linter mis-identifies it as a hook call. Off in tests/e2e only.
      'react-hooks/rules-of-hooks': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message:
            'Use expect.poll, expect(locator).toBeVisible(), or locator.waitFor instead of waitForTimeout (Phase 0 plan §11).',
        },
        {
          selector: "CallExpression[callee.object.name='setTimeout']",
          message: 'Sleep-based waits are forbidden. Use expect.poll or locator.waitFor.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['playwright', 'playwright-core'],
              message:
                'Import Page, Locator, BrowserContext, APIRequestContext from @playwright/test, not playwright.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/*.d.ts'],
  },
);
