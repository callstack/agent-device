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

export async function assertFormInput(context: LiveContext): Promise<void> {
  await runStep(context, 'open form tab', ['click', 'label="Form"']);
  await assertWaitText(context, 'Checkout form');

  const baseline = await runStep(context, 'establish form diff baseline', ['snapshot', '-i']);
  requireAndroidResourceId(baseline, 'field-name');
  await runStep(context, 'leave form before snapshot diff', ['back']);
  const diff = await runStep(context, 'observe form navigation diff', ['diff', 'snapshot', '-i']);
  const additions = Number(diff.json?.data?.summary?.additions ?? 0);
  const removals = Number(diff.json?.data?.summary?.removals ?? 0);
  assert.ok(
    additions + removals > 0,
    `expected non-empty form navigation diff: ${JSON.stringify(diff.json)}`,
  );
  const lines = Array.isArray(diff.json?.data?.lines)
    ? (diff.json.data.lines as { kind?: unknown; text?: unknown }[])
    : [];
  assert.ok(
    lines.some(
      (line) =>
        line.kind === 'removed' &&
        typeof line.text === 'string' &&
        line.text.includes('Checkout form'),
    ),
    `expected removed Checkout form evidence: ${JSON.stringify(diff.json)}`,
  );
  assert.ok(
    lines.some(
      (line) =>
        line.kind === 'added' &&
        typeof line.text === 'string' &&
        line.text.includes('Agent Device Tester'),
    ),
    `expected added Home evidence: ${JSON.stringify(diff.json)}`,
  );
  verifyCommand(context, C.diff, 'snapshot diff reports the Form-to-Home transition');

  await runStep(context, 'reopen form tab after diff', ['click', 'label="Form"']);
  await assertWaitText(context, 'Checkout form');
  await runStep(context, 'fill full name', ['fill', 'id="field-name"', 'Ada Lovelace']);

  const name = await runStep(context, 'read filled full name', ['get', 'text', 'id="field-name"']);
  assertJsonContains(name, 'Ada Lovelace', 'filled name should be observable in Android UI');
  verifyCommand(context, C.fill, 'replacement name text is read back from Android UI');

  await runStep(context, 'fill email field', ['fill', 'id="field-email"', 'ada@example']);
  const keyboardVisiblePath = path.join(context.artifactDir, 'keyboard-visible.png');
  await capturePng(context, 'capture visible Android keyboard', keyboardVisiblePath);
  const dismiss = await runStep(context, 'dismiss Android keyboard safely', [
    'keyboard',
    'dismiss',
  ]);
  assert.equal(dismiss.json?.data?.dismissed, true, JSON.stringify(dismiss.json));
  assert.equal(dismiss.json?.data?.visible, false, JSON.stringify(dismiss.json));
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
}
