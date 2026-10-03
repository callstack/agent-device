import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import * as maestro from './index.ts';

describe('@agent-device/maestro facade', () => {
  test('the package root contains declarations and re-exports only', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/^(?:import|const|let|var|function|class)\b/m);
  });

  test('keeps conformance and ranking machinery private', () => {
    const exports = Object.keys(maestro);
    expect(exports).not.toContain('parseMaestroConformanceSource');
    expect(exports).not.toContain('canonicalizeUpstreamMaestroFlow');
    expect(exports).not.toContain('SUPPORTED_MAESTRO_COMMAND_NAMES');
    expect(exports).not.toContain('MAESTRO_CONFORMANCE_CONSTANTS');
    expect(exports).not.toContain('MAESTRO_COMPATIBILITY_PRESETS');
    expect(exports).not.toContain('rankMaestroFailureCandidates');
  });

  test('keeps the daemon-side port off the engine entry and declares pure modules', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { exports: Record<string, unknown>; sideEffects?: boolean };
    // The daemon-side runtime port (#2544) and its runScript HTTP helper are subpaths, not part
    // of the engine entry. This pins the surface; scripts/__tests__/eager-closure-budgets.test.ts
    // is what keeps `.` from starting to evaluate host-kit, capture-kit, or provision-kit.
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './daemon-runtime-port',
      './run-script-http',
    ]);
    expect(manifest.sideEffects).toBe(false);
  });
});
