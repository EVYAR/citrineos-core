// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import pluginPrettier from 'eslint-plugin-prettier';
import { dirname } from 'path';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'url';
import { sharedConfigs, sharedIgnores } from '../../../eslint.config.base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  ...sharedConfigs.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  { ...eslint.configs.recommended, files: ['**/*.cjs'] },
  { ...prettierConfig, files: ['**/*.cjs'] },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        exports: 'writable',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
    plugins: { prettier: pluginPrettier },
    rules: { 'prettier/prettier': 'error' },
  },
  sharedIgnores,
  { ignores: ['config/eslint.config.js'] },
);
