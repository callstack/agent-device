import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref, selector } from '../../../src/commands/index.ts';
import { drawerWithVisibleTwinSnapshot } from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';

// ADR 0012 decision 2 mutation contract (validation bullet 2): pre-action
// resolution diagnostics are NOT refs. This suite proves the daemon-side half
// of that contract — the MCP-layer half (never ref-issued/pinned) is proven
// in src/mcp/__tests__/command-tools.test.ts. Together they cover: "an
// interaction mutation contract proving pre-action resolution diagnostics are
// not ref-issued or MCP-pinned, [and] a fresh snapshot is required before
// using an alternative."

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

  // A caller that mistakes the diagnostic entry for an actionable ref and
  // acts on it directly (WITHOUT a fresh snapshot/find first) gets the
  // ordinary unknown-ref refusal, not a silent success against a stale or
  // unintended node.
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

  // Even the WINNER's diagnostic token is a diagnostic, not a ref — the same
  // click already tapped it through `result.point`; the diagnostic entry
  // itself carries no separate authorization to re-target it later.
  await assert.rejects(
    () => device.interactions.press(ref(`@${winnerDiagnosticRef}`), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      return true;
    },
  );
});
