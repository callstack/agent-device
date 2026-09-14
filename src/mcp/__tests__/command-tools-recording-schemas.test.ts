import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

// `record stop` answers two independent questions (ADR 0024): whether a playable export exists, and
// whether its recorder stopped. Only the second one's words are additive properties here — the
// stopped branch's required list is what it was before either fact was reported.
const STOPPED_RECORDING: Readonly<Record<string, unknown>> = {
  recording: 'stopped',
  outPath: '/daemon/capture.mp4',
  artifacts: [],
  durationMs: 4_000,
  showTouches: false,
};

test('MCP record stop schema advertises the recorder word and the disposition beside it', () => {
  assert.deepEqual(
    validateAgainstSchema(
      { ...STOPPED_RECORDING, recorder: 'unconfirmed', nativePathDisposition: 'pending' },
      COMMAND_OUTPUT_SCHEMAS.record,
    ),
    [],
  );
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...STOPPED_RECORDING, recorder: 'probably-gone' },
      COMMAND_OUTPUT_SCHEMAS.record,
    ),
    [],
  );
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...STOPPED_RECORDING, nativePathDisposition: 'deleted' },
      COMMAND_OUTPUT_SCHEMAS.record,
    ),
    [],
  );
});

test('MCP record stop schema keeps both facts optional on an unchanged required list', () => {
  assert.deepEqual(validateAgainstSchema(STOPPED_RECORDING, COMMAND_OUTPUT_SCHEMAS.record), []);

  const stoppedBranch = COMMAND_OUTPUT_SCHEMAS.record.oneOf?.find(
    (branch) => branch.properties?.recording?.const === 'stopped',
  );
  assert.ok(stoppedBranch, 'record schema must advertise the stopped branch');
  assert.deepEqual(stoppedBranch.required, [
    'recording',
    'outPath',
    'artifacts',
    'durationMs',
    'showTouches',
  ]);
});
