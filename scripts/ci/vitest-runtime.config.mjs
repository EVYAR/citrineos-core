// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import config from '../../vitest.config.ts';

assert.ok(config.test && Array.isArray(config.test.projects), 'Expected monorepo Vitest projects');
export default {
  ...config,
  test: {
    ...config.test,
    projects: config.test.projects.map((project) => {
      assert.ok(
        project && typeof project === 'object' && project.test,
        'Expected inline Vitest project',
      );
      return {
        ...project,
        test: {
          ...project.test,
          maxWorkers: 1,
          minWorkers: 1,
          fileParallelism: false,
          // Vitest 3 CLI typecheck overrides do not propagate into inline projects.
          typecheck: { ...project.test.typecheck, enabled: false },
        },
      };
    }),
  },
};
