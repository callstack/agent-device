/**
 * #1478 (P4-pre): `flags.saveScript` is accepted only on the released
 * `--save-script` flag owners. Everything else is rejected at the daemon
 * request seam before any admission, session, or device work.
 */
import { expect, test } from 'vitest';
import { listSaveScriptFlagOwnerCommands, ownsSaveScriptFlag } from '../daemon-command-registry.ts';
import {
  SAVE_SCRIPT_FLAG_OWNER_COMMANDS,
  unsupportedSaveScriptFlagResponse,
} from '../request-save-script-policy.ts';
import type { DaemonRequest } from '../types.ts';

function request(command: string, flags: DaemonRequest['flags']): DaemonRequest {
  return { token: 'token', session: 'default', command, positionals: [], flags };
}

test('the flag owners are exactly the released open/close/replay surface', () => {
  expect(listSaveScriptFlagOwnerCommands()).toEqual(['close', 'open', 'replay']);
  expect(SAVE_SCRIPT_FLAG_OWNER_COMMANDS).toEqual(['close', 'open', 'replay']);
  for (const command of SAVE_SCRIPT_FLAG_OWNER_COMMANDS) {
    expect(ownsSaveScriptFlag(command)).toBe(true);
  }
  // `test` runs replay scripts but never declares `--save-script`, and the
  // internal publication command carries its path/force as positionals+flags of
  // its own — neither may arm through the raw flag.
  expect(ownsSaveScriptFlag('test')).toBe(false);
  expect(ownsSaveScriptFlag('session_save_script')).toBe(false);
});

test('owner commands and flag-free requests pass the seam untouched', () => {
  for (const command of SAVE_SCRIPT_FLAG_OWNER_COMMANDS) {
    expect(unsupportedSaveScriptFlagResponse(request(command, { saveScript: true }))).toBe(
      undefined,
    );
    expect(unsupportedSaveScriptFlagResponse(request(command, { saveScript: './flow.ad' }))).toBe(
      undefined,
    );
  }
  expect(unsupportedSaveScriptFlagResponse(request('record', {}))).toBe(undefined);
  expect(unsupportedSaveScriptFlagResponse(request('record', undefined))).toBe(undefined);
});

test.each(['record', 'trace', 'click', 'fill', 'snapshot', 'test', 'session_save_script'])(
  'raw saveScript on %s is rejected with an ADR 0010 shaped INVALID_ARGS error',
  (command) => {
    const response = unsupportedSaveScriptFlagResponse(request(command, { saveScript: true }));

    expect(response?.ok).toBe(false);
    if (!response || response.ok) return;
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('--save-script is supported only by close, open, replay.');
    // The per-code default hint ("check command arguments") would misdirect, so
    // the rejection names the surfaces that actually publish a script.
    expect(response.error.hint).toMatch(/session save-script/);
  },
);

test('presence is rejected, not truthiness — a raw false is unsupported too', () => {
  const response = unsupportedSaveScriptFlagResponse(request('record', { saveScript: false }));

  expect(response?.ok).toBe(false);
  if (!response || response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
});
