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
    options: './report.xml',
  });
});

test('parses JSON tuple reporter specs', () => {
  assert.deepEqual(parseReplayTestReporterSpec('["junit",{"output":"./report.xml"}]'), {
    kind: 'builtin',
    name: 'junit',
    raw: '["junit",{"output":"./report.xml"}]',
    options: { output: './report.xml' },
  });
  assert.deepEqual(parseReplayTestReporterSpec('["./reporter.mjs",{"output":"./out.txt"}]'), {
    kind: 'custom',
    modulePath: './reporter.mjs',
    raw: '["./reporter.mjs",{"output":"./out.txt"}]',
    options: { output: './out.txt' },
  });
});

test('parses custom reporter shorthand options', () => {
  assert.deepEqual(parseReplayTestReporterSpec('./reporter.mjs:{"output":"./out.txt"}'), {
    kind: 'custom',
    modulePath: './reporter.mjs',
    raw: './reporter.mjs:{"output":"./out.txt"}',
    options: { output: './out.txt' },
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
      options: './report.xml',
    },
  ]);
});

test('rejects invalid reporter specs', () => {
  assert.throws(() => parseReplayTestReporterSpec('["default",{},{}]'), /must contain/);
  assert.throws(() => parseReplayTestReporterSpec('unknown'), /Unknown test reporter/);
});
