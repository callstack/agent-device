// Child-process Vitest config for the contention retry gate's fixtures: the
// same setup and reporters the real lanes use, pointed at the fixture file.

import { defineConfig } from 'vitest/config';
import { reporters } from '../../vitest.config.ts';

export default defineConfig({
  test: {
    include: ['test/contention-retry-fixtures/*.fixture.ts'],
    reporters: reporters(),
    setupFiles: ['scripts/vitest-runner-timeout-setup.ts'],
  },
});
