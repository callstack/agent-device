import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildReplayTestReporterSpecs,
  parseReplayTestReporterSpec,
} from '../cli-test-reporters/spec.ts';

test('parses built-in reporter shorthand specs', () => {
  assert.deepEqual(parseReplayTestReporterSpec('default'), {
    kind: 'builtin',
    name: 'default',
    raw: 'default',
  });
  assert.deepEqual(parseReplayTestReporterSpec('junit:./report.xml'), {
    kind: 'builtin',
    name: 'junit',
    raw: 'junit:./report.xml',
    outputPath: './report.xml',
  });
});

test('parses custom reporter paths', () => {
  assert.deepEqual(parseReplayTestReporterSpec('./reporter.mjs'), {
    kind: 'custom',
    modulePath: './reporter.mjs',
    raw: './reporter.mjs',
  });
});

test('expands implicit and compatibility reporter defaults', () => {
  assert.deepEqual(buildReplayTestReporterSpecs({}), [
    { kind: 'builtin', name: 'default', raw: 'default' },
  ]);
  assert.deepEqual(buildReplayTestReporterSpecs({ json: true, reportJunit: './report.xml' }), [
    {
      kind: 'builtin',
      name: 'junit',
      raw: 'junit:./report.xml',
      outputPath: './report.xml',
    },
  ]);
});

test('rejects invalid reporter specs', () => {
  assert.throws(() => parseReplayTestReporterSpec('unknown'), /Unknown test reporter/);
});
