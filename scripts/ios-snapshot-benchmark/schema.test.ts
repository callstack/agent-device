import assert from 'node:assert/strict';
import { test } from 'vitest';
import { deepButtonFixtureEvidence } from './deep-button.ts';
import { assertValidRawResult, validateRawResult } from './schema.ts';
import type { BenchmarkResult } from './types.ts';

function result(): BenchmarkResult {
  return {
    schemaVersion: 'ios-snapshot-convergence.v1',
    issue: '#2189',
    parent: '#2188',
    references: { deepButton: '#1626', appMount: '#1571' },
    runId: 'schema-test',
    generatedAt: '2026-01-01T00:00:00.000Z',
    revision: { commit: 'abc', branch: 'test', dirty: false },
    toolchain: { node: 'v26', pnpm: '10', xcode: '27', simctl: '27', os: 'darwin', arch: 'arm64' },
    host: {
      model: 'MacBook Pro',
      modelIdentifier: 'Mac16,8',
      cpu: 'Apple M4 Pro',
      cpuCores: 12,
    },
    target: {
      platform: 'ios',
      kind: 'simulator',
      udid: 'simulator',
      name: 'bench',
      runtime: 'iOS 27',
      appId: 'com.callstack.agentdevicelab',
    },
    config: {
      warmSampleMinimum: 20,
      coldSampleMinimum: 10,
      requestedSamples: 20,
      screens: ['quiet'],
      states: ['warm'],
    },
    status: 'completed',
    measurements: [
      {
        transport: 'local',
        execution: 'fresh-process-cli',
        state: 'warm',
        screen: 'quiet',
        sampleMinimum: 20,
        operation: 'snapshot',
        samples: [
          {
            index: 1,
            startedAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:00.001Z',
            operation: 'snapshot',
            wallClockMs: 1,
            targetGeneration: null,
            firstTree: 'readable',
            ok: true,
            outlier: false,
          },
        ],
        wallClockMs: null,
        daemonDurationMs: null,
        responseBytes: null,
        failures: 0,
        failureCategories: {},
      },
    ],
    packageSize: { status: 'not-run', revision: 'abc' },
    deepButtonEvidence: deepButtonFixtureEvidence(),
  };
}

test('validates the raw result and rejects unknown or missing fields', () => {
  const value = result();
  assert.deepEqual(validateRawResult(value), []);
  assert.doesNotThrow(() => assertValidRawResult(value));
  assert.match(validateRawResult({ ...value, unexpected: true }).join('\n'), /unknown property/);
  assert.match(
    validateRawResult({
      ...value,
      measurements: [{ ...value.measurements[0], screen: 'unknown' }],
    }).join('\n'),
    /permitted enum/,
  );
});

test('accepts a stopped run before the first measurement cell', () => {
  const value = result();
  value.status = 'stopped';
  value.measurements = [];
  value.stop = {
    category: 'infrastructure',
    reason: 'fixture-anchor',
    message: 'fixture build unavailable',
  };
  assert.doesNotThrow(() => assertValidRawResult(value));
});
