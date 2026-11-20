import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COMMAND_OUTPUT_SCHEMAS } from '@agent-device/command-surface';
import { validateAgainstSchema } from './output-schema-validator.ts';

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

test('MCP record stop schema accepts a stop without a delivered path or recorder facts', () => {
  const { outPath: _outPath, ...undelivered } = STOPPED_RECORDING;
  assert.deepEqual(validateAgainstSchema(undelivered, COMMAND_OUTPUT_SCHEMAS.record), []);

  const stoppedBranch = COMMAND_OUTPUT_SCHEMAS.record.oneOf?.find(
    (branch) => branch.properties?.recording?.const === 'stopped',
  );
  assert.ok(stoppedBranch, 'record schema must advertise the stopped branch');
  assert.deepEqual(stoppedBranch.required, ['recording', 'artifacts', 'durationMs', 'showTouches']);
});
