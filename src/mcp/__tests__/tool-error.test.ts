import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { formatToolErrorText, normalizeToolError } from '../tool-error.ts';

// #1597: an MCP-connected agent reads this text, not the CLI's stderr — the
// candidate refs must render here too, unconditionally, same as
// printHumanError (src/commands/output/error.ts, src/commands/output/error.test.ts).
test('formatToolErrorText lists AMBIGUOUS_MATCH candidates capped with a "+N more" marker', () => {
  const err = new AppError(
    'AMBIGUOUS_MATCH',
    'find matched 6 elements for text "Follow". Use a more specific locator or selector.',
    {
      matches: 6,
      candidates: [
        '@e2 [button] "Follow"',
        '@e3 [button] "Follow"',
        '@e4 [button] "Follow"',
        '@e5 [button] "Follow"',
        '@e6 [button] "Follow"',
      ],
    },
  );

  const text = formatToolErrorText(normalizeToolError(err));

  assert.match(text, /^Error \(AMBIGUOUS_MATCH\): find matched 6 elements/);
  assert.match(text, /Hint: Multiple candidates matched\./);
  assert.match(text, /Candidates:\n {2}@e2 \[button\] "Follow"/);
  assert.match(text, /@e6 \[button\] "Follow"\n {2}\+1 more/);
});

test('formatToolErrorText omits the candidates block for non-ambiguous errors', () => {
  const err = new AppError('COMMAND_FAILED', 'find did not match any element');

  const text = formatToolErrorText(normalizeToolError(err));

  assert.equal(text.includes('Candidates:'), false);
});

test('formatToolErrorText renders a structured cause', () => {
  const err = new AppError(
    'COMMAND_FAILED',
    'The daemon failed to fetch the app source',
    undefined,
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    }),
  );

  const text = formatToolErrorText(normalizeToolError(err));

  assert.match(text, /Cause: ECONNREFUSED connect ECONNREFUSED 10\.0\.0\.1:443/);
});

// Device-domain AMBIGUOUS_MATCH (findBootedAppleSimulatorWithApp,
// src/core/dispatch-resolve.ts) keys its list `devices`, so the MCP text path
// carries the udids the hint asks for — same block as the CLI.
test('formatToolErrorText lists device-domain candidates udid-first', () => {
  const err = new AppError(
    'AMBIGUOUS_MATCH',
    'Multiple booted iOS simulators have com.example.app installed',
    {
      appTarget: 'com.example.app',
      devices: [
        { id: 'SIM-001', name: 'iPhone 17 Pro' },
        { id: 'SIM-002', name: 'iPhone 17' },
      ],
    },
  );

  const text = formatToolErrorText(normalizeToolError(err));

  assert.match(text, /Devices:\n {2}SIM-001 {2}iPhone 17 Pro\n {2}SIM-002 {2}iPhone 17/);
  assert.equal(text.includes('[object Object]'), false);
});
