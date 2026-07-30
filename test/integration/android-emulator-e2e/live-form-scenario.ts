import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import {
  assertElementText,
  assertFilesDiffer,
  assertJsonContains,
  assertWaitText,
  capturePng,
  requireAndroidResourceId,
} from './live-assertions.ts';
import { type LiveContext, runStep, verifyBehavior, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;
const ANDROID_TEST_IME_PACKAGE = 'com.callstack.agentdevice.imehelper';
const ANDROID_TEST_IME_SERVICE = `${ANDROID_TEST_IME_PACKAGE}/.TestInputMethodService`;

export async function assertFormInput(context: LiveContext): Promise<void> {
  const keyboardStatus = await runStep(context, 'verify deterministic test IME active', [
    'keyboard',
    'status',
  ]);
  assert.equal(
    keyboardStatus.json?.data?.inputMethodPackage,
    ANDROID_TEST_IME_PACKAGE,
    JSON.stringify(keyboardStatus.json),
  );

  await runStep(context, 'fill Unicode full name through test IME', [
    'fill',
    'id="field-name"',
    'Ada Łovelace',
  ]);
  const name = await runStep(context, 'read filled full name', ['get', 'text', 'id="field-name"']);
  assertJsonContains(name, 'Ada Łovelace', 'Unicode name should be observable in Android UI');
  verifyCommand(context, C.fill, 'Unicode replacement text is read back from Android UI');
  verifyBehavior(
    context,
    'test-ime-unicode-input',
    `active ${ANDROID_TEST_IME_PACKAGE} committed and read back Ada Łovelace`,
  );

  await runStep(context, 'fill email field', ['fill', 'id="field-email"', 'ada@example']);
  const snapshot = await runStep(context, 'locate email Android resource-id', ['snapshot', '-i']);
  const email = requireAndroidResourceId(snapshot, 'field-email');
  await runStep(context, 'focus email by snapshot-derived point', [
    'focus',
    String(email.rect.x + email.rect.width / 2),
    String(email.rect.y + email.rect.height / 2),
  ]);
  await runStep(context, 'append email suffix', ['type', '.test']);
  await assertElementText(context, 'id="field-email"', 'ada@example.test');
  verifyCommand(context, C.focus, `snapshot resource-id ${email.identifier} directs focus`);
  verifyCommand(context, C.type, 'typed suffix is read back from focused Android field');

  await runStep(context, 'close test IME session and restore prior input method', ['close']);
  const doctor = await runStep(context, 'verify prior Android IME restored', [
    'doctor',
    '--app',
    context.appId,
  ]);
  const checks: unknown = doctor.json?.data?.checks;
  assert.ok(Array.isArray(checks), JSON.stringify(doctor.json));
  const imeCheck = checks.find(
    (
      check: unknown,
    ): check is { evidence?: { currentIme?: unknown }; id: string; status?: unknown } =>
      typeof check === 'object' &&
      check !== null &&
      (check as { id?: unknown }).id === 'android-test-ime',
  );
  assert.ok(imeCheck, JSON.stringify(doctor.json));
  assert.equal(imeCheck.status, 'pass', JSON.stringify(imeCheck));
  assert.equal(typeof imeCheck.evidence?.currentIme, 'string', JSON.stringify(imeCheck));
  assert.notEqual(
    imeCheck.evidence?.currentIme,
    ANDROID_TEST_IME_SERVICE,
    JSON.stringify(imeCheck),
  );
  verifyBehavior(
    context,
    'test-ime-restoration',
    `close restored ${String(imeCheck.evidence?.currentIme)} instead of ${ANDROID_TEST_IME_SERVICE}`,
  );
}

export async function assertKeyboardIme(context: LiveContext): Promise<void> {
  await runStep(context, 'focus email with the emulator keyboard', [
    'click',
    'id="field-email"',
    '--settle',
  ]);
  const keyboardStatus = await runStep(context, 'verify Android keyboard visible', [
    'keyboard',
    'status',
  ]);
  assert.equal(keyboardStatus.json?.data?.visible, true, JSON.stringify(keyboardStatus.json));
  assert.equal(
    typeof keyboardStatus.json?.data?.inputMethodPackage,
    'string',
    JSON.stringify(keyboardStatus.json),
  );
  assert.notEqual(
    keyboardStatus.json?.data?.inputMethodPackage,
    ANDROID_TEST_IME_PACKAGE,
    JSON.stringify(keyboardStatus.json),
  );

  const keyboardVisiblePath = path.join(context.artifactDir, 'keyboard-visible.png');
  await capturePng(context, 'capture visible Android keyboard', keyboardVisiblePath);
  const dismiss = await runStep(context, 'dismiss Android keyboard safely', [
    'keyboard',
    'dismiss',
  ]);
  assert.equal(dismiss.json?.data?.dismissed, true, JSON.stringify(dismiss.json));
  assert.equal(dismiss.json?.data?.visible, false, JSON.stringify(dismiss.json));
  assert.notEqual(
    dismiss.json?.data?.inputMethodPackage,
    ANDROID_TEST_IME_PACKAGE,
    JSON.stringify(dismiss.json),
  );

  const keyboardHiddenPath = path.join(context.artifactDir, 'keyboard-hidden.png');
  await capturePng(context, 'capture dismissed Android keyboard', keyboardHiddenPath);
  assertFilesDiffer(
    keyboardVisiblePath,
    keyboardHiddenPath,
    'keyboard dismissal should change emulator pixels',
  );
  await assertWaitText(context, 'Checkout form');
  verifyCommand(
    context,
    C.keyboard,
    'dismiss reports hidden keyboard while the Checkout form remains on screen',
  );
  verifyBehavior(
    context,
    'safe-keyboard-dismissal',
    'before/after pixels changed and Checkout form remained visible after non-Back dismissal',
  );
  verifyBehavior(
    context,
    'system-ime-keyboard',
    `visible and dismissed keyboard used ${String(keyboardStatus.json?.data?.inputMethodPackage)}`,
  );
}
