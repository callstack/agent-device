import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { findProjectRoot } from '../../../utils/version.ts';

// Security guard for #1201: the text-injection broadcast receiver must require a sender permission
// that only adb shell / privileged callers hold, so a co-installed third-party app cannot inject
// text into the focused field while the test IME is active. A permissionless RECEIVER_EXPORTED
// registration (the original vulnerability) must never come back.

const SERVICE_SRC = path.join(
  findProjectRoot(),
  'android/ime-helper/src/main/java/com/callstack/agentdevice/imehelper/TestInputMethodService.java',
);

function readService(): string {
  return readFileSync(SERVICE_SRC, 'utf8');
}

test('the receiver requires the WRITE_SECURE_SETTINGS sender permission', () => {
  const service = readService();
  assert.match(service, /Manifest\.permission\.WRITE_SECURE_SETTINGS/);
  // Both registration overloads used (API 33+ and legacy) must pass the required permission.
  // \b excludes unregisterReceiver().
  const registrations = [...service.matchAll(/\bregisterReceiver\(([\s\S]*?)\);/g)];
  assert.ok(registrations.length >= 1, 'expected at least one registerReceiver call');
  for (const match of registrations) {
    const argList = match[1] ?? '';
    assert.match(
      argList,
      /REQUIRED_SENDER_PERMISSION/,
      'every registerReceiver call must pass the sender permission',
    );
  }
});

test('the receiver is never registered exported without a permission gate', () => {
  const service = readService();
  // The permissionless 3-arg exported form `registerReceiver(receiver, filter, RECEIVER_EXPORTED)`
  // is the exact injection surface the review flagged; assert it is gone.
  assert.doesNotMatch(
    service,
    /registerReceiver\(\s*receiver,\s*filter,\s*Context\.RECEIVER_EXPORTED\s*\)/,
  );
  assert.doesNotMatch(service, /registerReceiver\(\s*receiver,\s*filter\s*\)/);
});
