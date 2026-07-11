import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import { parseReplayInput } from '../replay-input.ts';

test('parseReplayInput routes compat replay scripts through the selected parser', () => {
  const parsed = parseReplayInput(
    `appId: com.callstack.agentdevicelab
---
- launchApp
- tapOn:
    id: submit-order
`,
    { replayBackend: 'maestro' },
  );

  assert.deepEqual(
    parsed.actions.map((action) => [action.command, action.positionals]),
    [
      ['open', ['com.callstack.agentdevicelab']],
      ['__maestroTapOn', ['id="submit-order"']],
    ],
  );
});

test('parseReplayInput applies replay env precedence before compat parsing', () => {
  const parsed = parseReplayInput(
    `appId: \${APP_ID}
env:
  APP_ID: yaml-app
  BUTTON_ID: yaml-button
---
- launchApp
- tapOn:
    id: \${BUTTON_ID}
`,
    {
      replayBackend: 'maestro',
      replayShellEnv: { AD_VAR_APP_ID: 'shell-app', AD_VAR_BUTTON_ID: 'shell-button' },
      replayEnv: ['APP_ID=cli-app'],
    },
  );

  assert.equal(parsed.metadata.env?.APP_ID, 'yaml-app');
  assert.deepEqual(
    parsed.actions.map((action) => [action.command, action.positionals]),
    [
      ['open', ['cli-app']],
      ['__maestroTapOn', ['id="shell-button"']],
    ],
  );
});

test('parseReplayInput rejects unknown replay backends', () => {
  assert.throws(
    () => parseReplayInput('open Demo\n', { replayBackend: 'unknown' }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Unsupported replay backend "unknown"/.test(error.message),
  );
});
