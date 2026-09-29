import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { RECORDING_COMMAND_OUTPUT_SCHEMAS } from '../../commands/recording/output-schemas.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

const RECORDING_COMMANDS = Object.keys(RECORDING_COMMAND_OUTPUT_SCHEMAS) as Array<
  keyof typeof RECORDING_COMMAND_OUTPUT_SCHEMAS
>;

// Neither record nor trace carries the post-action observation trait (#1652): both fire-and-report
// a recording or trace lifecycle change, not an interaction, so the composed map never copies
// either entry and reference equality must hold for both.
test('MCP recording family output schemas are the family module entries, not copies', () => {
  for (const command of RECORDING_COMMANDS) {
    assert.equal(
      COMMAND_OUTPUT_SCHEMAS[command],
      RECORDING_COMMAND_OUTPUT_SCHEMAS[command],
      `${command} is not reference-equal to the recording module's own schema object`,
    );
  }
});

test('the projected family map declares exactly the commands its module owns', () => {
  for (const command of RECORDING_COMMANDS) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/recording/output-schemas.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});

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
