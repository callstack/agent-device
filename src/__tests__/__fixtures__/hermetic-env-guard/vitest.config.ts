import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// A minimal standalone project rooted at this fixture dir. It wires the REAL
// hermetic-env setup file (so deleting or breaking that file fails the guard),
// unless HERMETIC_GUARD_DISABLE_SETUP=1 — the negative control that proves the
// probe is actually sensitive to the ambient vars. Driven by
// hermetic-env-guard.test.ts.
export default defineConfig({
  test: {
    root: here,
    include: ['hermetic-env-probe.ts'],
    setupFiles:
      process.env.HERMETIC_GUARD_DISABLE_SETUP === '1'
        ? []
        : [path.resolve(here, '../../hermetic-env-setup.ts')],
  },
});
