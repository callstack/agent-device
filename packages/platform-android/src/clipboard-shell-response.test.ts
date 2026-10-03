import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  androidClipboardShellCommandUnavailableError,
  androidClipboardShellSupportForVerdict,
  ANDROID_CLIPBOARD_SHELL_COMMAND_UNAVAILABLE_REASON,
  classifyAndroidClipboardShellResponse,
} from './clipboard-shell-response.ts';

// Android 16 (API 36): `ClipboardService` implements no shell command, so the framework default
// answers with its sentence on stderr and a clean exit. A classifier that settles the exit status
// first reports a clipboard that no adb call ever touched.
test('clipboard shell classification refuses the no-implementation answer despite a clean exit', () => {
  assert.equal(
    classifyAndroidClipboardShellResponse({
      stdout: '',
      stderr: 'No shell command implementation.',
      exitCode: 0,
    }),
    'no-shell-command',
  );
});

test('clipboard shell classification reports a clipboard the service actually answered', () => {
  assert.equal(
    classifyAndroidClipboardShellResponse({
      stdout: 'clipboard text: otp-123456\n',
      stderr: '',
      exitCode: 0,
    }),
    'executed',
  );
});

// A read that ran answers on stdout with arbitrary user text, so stdout is never evidence about the
// call — whatever a clipboard happens to hold stays clipboard contents.
test('clipboard shell classification keeps copied prose from looking like a refusal', () => {
  for (const contents of ['Unknown command: clipboard', 'No shell command implementation.']) {
    assert.equal(
      classifyAndroidClipboardShellResponse({ stdout: contents, stderr: '', exitCode: 0 }),
      'executed',
      contents,
    );
  }
});

// Older adb merges the device's streams onto stdout, so prose there is evidence once the call itself
// is known to have failed.
test('clipboard shell classification reads a refusal off stdout once the call failed', () => {
  assert.equal(
    classifyAndroidClipboardShellResponse({
      stdout: 'No shell command implementation.',
      stderr: '',
      exitCode: 255,
    }),
    'no-shell-command',
  );
});

// `unknown command` is adb's own wording as well as a service's (`adb: unknown command features`), so
// it cannot say anything about this device's clipboard service on a call that succeeded. Only the
// framework's no-shell-command sentence outranks a clean exit.
test('clipboard shell classification refuses to read adb prose as a device verdict', () => {
  assert.equal(
    classifyAndroidClipboardShellResponse({
      stdout: 'clipboard text: otp-123456\n',
      stderr: 'adb: unknown command features',
      exitCode: 0,
    }),
    'executed',
  );
});

// Streams separated, both talking: a service that printed its no-shell-command sentence never ran
// the command, so whatever shares the call is not the payload it was asked for.
test('clipboard shell classification believes the sentence over a stream it did not write', () => {
  assert.equal(
    classifyAndroidClipboardShellResponse({
      stdout: 'clipboard text: otp-123456\n',
      stderr: 'No shell command implementation.',
      exitCode: 0,
    }),
    'no-shell-command',
  );
});

test('clipboard shell classification keeps a broken transport out of the missing-command verdict', () => {
  assert.equal(
    classifyAndroidClipboardShellResponse({
      stdout: '',
      stderr: 'error: device offline',
      exitCode: 1,
    }),
    'call-failed',
  );
});

test('clipboard shell support verdicts carry the execution answer to admission', () => {
  assert.equal(androidClipboardShellSupportForVerdict('executed'), 'supported');
  assert.equal(androidClipboardShellSupportForVerdict('no-shell-command'), 'unsupported');
  assert.equal(androidClipboardShellSupportForVerdict('call-failed'), 'probe-failed');
});

test('clipboard shell refusal is dispatchable and names the substitute', () => {
  const error = androidClipboardShellCommandUnavailableError('read');
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(
    (error.details as { reason?: unknown }).reason,
    ANDROID_CLIPBOARD_SHELL_COMMAND_UNAVAILABLE_REASON,
  );
  assert.match(String(normalizeError(error).hint), /pasting into a focused field/);
});
