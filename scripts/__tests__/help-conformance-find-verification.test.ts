import assert from 'node:assert/strict';
import { test } from 'vitest';
import { hasFindExists } from '../help-conformance-expectations.mjs';
import { validatePlanCommands } from '../help-conformance-plan-validator.mjs';

// The find verification check reads plan commands through the real plan tokenizer, so quoting is
// the tokenizer's job and the find grammar is parseFindArgs'.
async function verifies(command: string, subject?: string): Promise<boolean> {
  return hasFindExists(await validatePlanCommands([command]), subject);
}

test('find ... exists verifies, whatever quotes its query holds', async () => {
  assert.equal(await verifies(`agent-device find text "Today's" exists`), true);
  assert.equal(await verifies(String.raw`agent-device find text "Welcome \"back\"" exists`), true);
  assert.equal(await verifies('agent-device find "Welcome back" exists', 'welcome'), true);
});

test('a find that acts, or names another subject, does not verify', async () => {
  assert.equal(await verifies('agent-device find text "Sent"'), false);
  assert.equal(await verifies('agent-device find text Sent fill exists'), false);
  assert.equal(await verifies('agent-device find text "Orders" exists', 'welcome'), false);
});

test('a find with an unsupported action scores false instead of throwing', async () => {
  assert.equal(await verifies('agent-device find text Sent swipe'), false);
});
