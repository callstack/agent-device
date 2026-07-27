import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AMBIGUOUS_MATCH_SAMPLE,
  APP_NOT_INSTALLED_SAMPLE,
  DEVICE_IN_USE_SAMPLE,
  NOT_SETTLED_SAMPLE,
  PRIVATE_AX_RECOVERY_SAMPLE,
  SETTLE_DIFF_SAMPLE,
  SETTLE_DIFF_SAMPLE_NOTES,
  SETTLE_TAIL_SAMPLE,
  STALE_REF_SAMPLE,
} from '../help-conformance-sample-outputs.mjs';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import { NEVER_SETTLED_HINT } from '../../src/commands/interaction/runtime/settle.ts';
import { buildAmbiguousMatchError } from '../../src/daemon/handlers/find.ts';
import { refMutationAdmissionResponse } from '../../src/daemon/handlers/interaction-ref-policy.ts';
import { buildDeviceInUseBySessionError } from '../../src/daemon/handlers/session-open.ts';
import { resolveRefStalenessWarning } from '../../src/daemon/session-snapshot.ts';
import type { SessionState } from '../../src/daemon/types.ts';
import { buildAppNotInstalledError } from '../../src/platforms/apple/core/app-resolution.ts';
import { AppError, normalizeError } from '../../src/kernel/errors.ts';
import type { SnapshotQualityVerdict } from '../../src/snapshot/snapshot-quality.ts';
import { renderSnapshotQualityWarnings } from '../../src/snapshot/snapshot-quality.ts';
import { formatSnapshotText, printHumanError } from '../../src/utils/output.ts';

// Every quiz case in scripts/help-conformance-cases.mjs quotes "captured"
// agent-device output. These tests rebuild each quoted sample through the real
// production renderer, so a rendering or message change fails HERE instead of
// leaving the benchmark grading models against output the CLI no longer
// prints — the drift class that made hand-transcribed samples untrustworthy.

const formatPress = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.press({ input: {}, result });

const formatFill = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.fill({ input: {}, result });

function renderHumanError(error: AppError): string {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    printHumanError(normalizeError(error));
  } finally {
    process.stderr.write = originalWrite;
  }
  return lines.join('').trimEnd();
}

test('settle tail sample matches the press renderer, including ADR 0014 pinning', () => {
  const output = formatPress({
    ref: 'e37',
    x: 203,
    y: 88,
    settle: {
      settled: true,
      waitedMs: 540,
      refsGeneration: 5,
      diff: {
        summary: { additions: 0, removals: 1, unchanged: 15 },
        lines: [{ kind: 'removed', text: '@e50 [text] "Suggested for you"' }],
      },
      tail: [
        { ref: 'e64', role: 'text-field', label: 'Search' },
        { ref: 'e65', role: 'text', label: 'Recent searches' },
        { ref: 'e12', role: 'tab', label: 'Home' },
        { ref: 'e40', role: 'tab', label: 'Profile' },
      ],
    },
  });
  assert.equal(output.text, SETTLE_TAIL_SAMPLE.output);
});

test('settled diff sample matches the fill renderer', () => {
  const output = formatFill({
    text: 'callstack',
    message: 'Filled 9 chars',
    settle: {
      settled: true,
      waitedMs: 610,
      refsGeneration: 6,
      diff: {
        summary: { additions: 2, removals: 0, unchanged: 18 },
        lines: [
          { kind: 'added', text: '@e64 [button] "@callstack.com"' },
          { kind: 'added', text: '@e65 [text] "Callstack"' },
        ],
      },
    },
  });
  assert.equal(output.text, SETTLE_DIFF_SAMPLE.output);
});

test('metamorphic settled diff sample matches the fill renderer', () => {
  const output = formatFill({
    text: 'groceries',
    message: 'Filled 9 chars',
    settle: {
      settled: true,
      waitedMs: 480,
      refsGeneration: 3,
      diff: {
        summary: { additions: 2, removals: 0, unchanged: 11 },
        lines: [
          { kind: 'added', text: '@e21 [button] "Groceries list"' },
          { kind: 'added', text: '@e22 [text] "3 items"' },
        ],
      },
    },
  });
  assert.equal(output.text, SETTLE_DIFF_SAMPLE_NOTES.output);
});

test('not-settled sample matches the press renderer and the production hint', () => {
  const output = formatPress({
    ref: 'e12',
    x: 166,
    y: 240,
    settle: { settled: false, waitedMs: 10_000, hint: NEVER_SETTLED_HINT },
  });
  assert.equal(output.text, NOT_SETTLED_SAMPLE.output);
});

test('private-ax recovery sample matches the snapshot renderer and quality warning', () => {
  const nodes = [
    {
      index: 1,
      ref: 'e5',
      type: 'Button',
      label: 'Search',
      interactive: true,
      rect: { x: 20, y: 120, width: 200, height: 44 },
    },
    {
      index: 2,
      ref: 'e8',
      type: 'Tab',
      label: 'Home',
      selected: true,
      interactive: true,
      rect: { x: 0, y: 780, width: 100, height: 60 },
    },
  ];
  const verdict = { state: 'recovered', backend: 'private-ax' } as SnapshotQualityVerdict;
  const text = formatSnapshotText({
    nodes,
    backend: 'private-ax',
    snapshotQuality: verdict,
    warnings: renderSnapshotQualityWarnings(verdict, nodes),
    interactiveOnly: true,
  });
  assert.equal(text.trimEnd(), PRIVATE_AX_RECOVERY_SAMPLE.output);
});

test('device-in-use sample matches the real session-open producer', () => {
  const owningSession = { name: 'checkout' } as SessionState;
  const device = { id: 'SIM-001', name: 'iPhone 17 Pro' } as Parameters<
    typeof buildDeviceInUseBySessionError
  >[1];
  const response = buildDeviceInUseBySessionError(owningSession, device);
  assert.ok(!response.ok, 'the by-session conflict must be an error response');
  const rendered = renderHumanError(
    new AppError(
      response.error.code as ConstructorParameters<typeof AppError>[0],
      response.error.message,
      response.error.details,
    ),
  );
  assert.equal(rendered, DEVICE_IN_USE_SAMPLE.output);
});

test('stale-ref sample matches the real admission rejection and staleness hint', () => {
  const session = { refFrameGeneration: 7 } as SessionState;
  const response = refMutationAdmissionResponse({
    session,
    ref: '@e12',
    mintedGeneration: 5,
    staleRefsWarning: resolveRefStalenessWarning({ session, ref: '@e12', mintedGeneration: 5 }),
  });
  assert.ok(response && !response.ok, 'a superseded pin must be rejected');
  const rendered = renderHumanError(
    new AppError(
      response.error.code as ConstructorParameters<typeof AppError>[0],
      response.error.message,
      response.error.details,
    ),
  );
  assert.equal(rendered, STALE_REF_SAMPLE.output);
});

test('ambiguous-match sample matches the real find producer and default hint', () => {
  const matches = [
    { ref: 'e2', label: 'Follow' },
    { ref: 'e5', label: 'Follow' },
    { ref: 'e9', label: 'Follow' },
  ] as Parameters<typeof buildAmbiguousMatchError>[0];
  const response = buildAmbiguousMatchError(matches, 'text', 'Follow');
  assert.ok(!response.ok, 'an ambiguous find must be an error response');
  const rendered = renderHumanError(
    new AppError(
      response.error.code as ConstructorParameters<typeof AppError>[0],
      response.error.message,
      response.error.details,
    ),
  );
  assert.equal(rendered, AMBIGUOUS_MATCH_SAMPLE.output);
});

test('app-not-installed sample matches the real app-resolution producer and default hint', () => {
  const rendered = renderHumanError(buildAppNotInstalledError('Shoply'));
  assert.equal(rendered, APP_NOT_INSTALLED_SAMPLE.output);
});
