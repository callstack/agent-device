import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertElementText, assertWaitText } from './live-assertions.ts';
import { type LiveContext, runStep, verifyBehavior, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;
const AUTOMATION_DEEP_LINK =
  'agent-device-test-app:///automation?event=full.lifecycle&payload=%7B%22source%22%3A%22android-nightly%22%7D';
export const ANDROID_PERMISSION_PROMPT_COMMAND = ['alert', 'wait', '10000'] as const;

export async function assertLifecycleAndSystem(context: LiveContext): Promise<void> {
  await runStep(context, 'open Android fixture lifecycle route', [
    'open',
    context.appId,
    '--relaunch',
    AUTOMATION_DEEP_LINK,
  ]);
  await assertWaitText(context, 'Automation lab');

  await assertPermissionRecovery(context);
  await assertPushBroadcast(context);
  await assertImeRecovery(context);
}

async function assertPermissionRecovery(context: LiveContext): Promise<void> {
  await resetAndRequestMicrophonePermission(context, 'accept');
  await assertElementText(context, 'id="automation-microphone-permission"', 'granted');

  await resetAndRequestMicrophonePermission(context, 'deny');
  await assertElementText(context, 'id="automation-microphone-permission"', 'denied');

  await resetAndRequestMicrophonePermission(context, 'accept after denial');
  await assertElementText(context, 'id="automation-microphone-permission"', 'granted');

  await runStep(context, 'revoke Android microphone permission', [
    'settings',
    'permission',
    'deny',
    'microphone',
  ]);
  await runStep(context, 'background fixture before revoked permission readback', ['home']);
  await runStep(context, 'restore fixture after microphone revocation', ['open', context.appId]);
  await assertWaitText(context, 'Automation lab');
  await assertElementText(context, 'id="automation-microphone-permission"', 'denied');
  verifyCommand(
    context,
    C.settings,
    'prompt accept, prompt deny, and adb revoke transitions are fixture-visible',
  );
  verifyBehavior(
    context,
    'runtime-permission-recovery',
    'fixture observed native prompt accept and deny, then app-active readback after pm revoke',
  );
}

async function resetAndRequestMicrophonePermission(
  context: LiveContext,
  action: 'accept' | 'deny' | 'accept after denial',
): Promise<void> {
  await runStep(context, `reset microphone permission before ${action}`, [
    'settings',
    'permission',
    'reset',
    'microphone',
  ]);
  await runStep(context, `scroll to microphone permission control before ${action}`, [
    'scroll',
    'bottom',
  ]);
  await runStep(context, `request Android microphone permission for ${action}`, [
    'click',
    'id="automation-request-microphone"',
  ]);
  const prompt = await runStep(context, `inspect Android microphone prompt for ${action}`, [
    ...ANDROID_PERMISSION_PROMPT_COMMAND,
  ]);
  assert.equal(prompt.json?.data?.alert?.source, 'permission', JSON.stringify(prompt.json));
  const alertAction = action === 'deny' ? 'dismiss' : 'accept';
  await runStep(context, `${action} Android microphone permission prompt`, ['alert', alertAction]);
}

async function assertPushBroadcast(context: LiveContext): Promise<void> {
  const payload = JSON.stringify({ extras: { count: 7, source: 'android-nightly' } });
  const pushed = await runStep(context, 'broadcast typed Android fixture push', [
    'push',
    context.appId,
    payload,
  ]);
  assert.equal(pushed.json?.data?.package, context.appId, JSON.stringify(pushed.json));
  assert.equal(pushed.json?.data?.extrasCount, 2, JSON.stringify(pushed.json));
  await runStep(context, 'scroll to Android push receiver state', ['scroll', 'bottom']);
  await runStep(context, 'refresh fixture push receiver state', [
    'click',
    'id="automation-refresh-push-broadcast"',
  ]);
  await assertElementText(
    context,
    'id="automation-last-push-broadcast"',
    'source=android-nightly,count=7',
  );
  verifyCommand(context, C.push, 'typed broadcast action and extras reach the fixture receiver');
  verifyBehavior(
    context,
    'push-broadcast-delivery',
    'fixture rendered the source and count persisted by its Android broadcast receiver',
  );
}

async function assertImeRecovery(context: LiveContext): Promise<void> {
  await runStep(context, 'open Android fixture form for IME recovery', ['click', 'label="Form"']);
  await assertWaitText(context, 'Checkout form');
  await runStep(context, 'fill Android IME recovery field', [
    'fill',
    'id="field-ime-capture-target"',
    'agent-device',
  ]);
  const status = await runStep(context, 'inspect Android IME ownership after fill', [
    'keyboard',
    'status',
  ]);
  assert.equal(status.json?.data?.visible, true, JSON.stringify(status.json));
  await runStep(context, 'dismiss Android IME after fill recovery', ['keyboard', 'dismiss']);
  await runStep(context, 'scroll to Android IME diagnostic', ['scroll', 'bottom']);
  await assertWaitText(context, 'Android fill input was captured by the active keyboard');
  await assertElementText(context, 'id="field-ime-capture-target"', 'agent-device');
  verifyBehavior(
    context,
    'ime-owned-input-recovery',
    'fixture input survived IME dismissal and its Android ownership diagnostic remained observable',
  );
}
