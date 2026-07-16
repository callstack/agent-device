import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref, selector } from '../../../src/commands/interaction/runtime/selector-read.ts';
import { drawerWithVisibleTwinSnapshot } from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';

// ADR 0012 mutation contract, daemon half: diagnosticRef tokens are not refs.
// The MCP half (never ref-issued/pinned) lives in src/mcp/__tests__/command-tools.test.ts.

test('resolution mutation contract: a diagnosticRef is not a resolvable @ref target', async () => {
  const device = createContractDevice(drawerWithVisibleTwinSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(selector('label=Profile'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  const resolution = result.resolution;
  assert.equal(resolution?.kind, 'disambiguated');
  if (resolution?.kind !== 'disambiguated') return;
  const alternativeDiagnosticRef = resolution.alternatives[0]?.diagnosticRef;
  assert.ok(
    alternativeDiagnosticRef,
    'the disambiguated resolution must carry a losing alternative',
  );

  // Acting on it without a fresh snapshot gets the ordinary unknown-ref refusal.
  await assert.rejects(
    () => device.interactions.press(ref(`@${alternativeDiagnosticRef}`), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, new RegExp(`Ref @${alternativeDiagnosticRef} not found`));
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.match(String(details?.hint), /refs expire/i);
      return true;
    },
  );
});

test('resolution mutation contract: the winner diagnosticRef is also not a resolvable @ref target', async () => {
  const device = createContractDevice(drawerWithVisibleTwinSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(selector('label=Profile'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  const resolution = result.resolution;
  assert.equal(resolution?.kind, 'disambiguated');
  if (resolution?.kind !== 'disambiguated') return;
  const winnerDiagnosticRef = resolution.winnerDiagnostic.diagnosticRef;

  // The winner's token is equally non-actionable.
  await assert.rejects(
    () => device.interactions.press(ref(`@${winnerDiagnosticRef}`), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      return true;
    },
  );
});
