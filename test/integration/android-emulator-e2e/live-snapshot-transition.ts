import assert from 'node:assert/strict';

import type { SnapshotDiffLine } from '@agent-device/contracts/capture';
import type { AndroidLiveHarness, LiveContext } from './live-harness.ts';

const SNAPSHOT_TRANSITION_TIMEOUT_MS = 10_000;
const SNAPSHOT_TRANSITION_POLL_MS = 250;

/** One diff line the transition must report: its kind and a fragment of its text. */
export type ExpectedDiffLine = { kind: SnapshotDiffLine['kind']; text: string };

/**
 * Reads `diff snapshot -i` until the expected lines have all been reported. Navigation (Back) is
 * dispatched before the destination has rendered, so one diff right after the command can still
 * describe the previous screen. Every diff stores its capture as the next baseline, so
 * consecutive diffs chain: a line is expected once across the chain, not in every diff. A new
 * diff starts only before the deadline, and the wait fails with the last diff if the transition
 * never reports a line.
 */
export async function waitForSnapshotDiffLines(
  context: LiveContext,
  runStep: AndroidLiveHarness['runStep'],
  step: string,
  expected: readonly ExpectedDiffLine[],
): Promise<void> {
  const deadline = Date.now() + SNAPSHOT_TRANSITION_TIMEOUT_MS;
  let missing = [...expected];
  let lastDiff: unknown;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const diff = await runStep(context, `${step} (attempt ${attempt})`, ['diff', 'snapshot', '-i']);
    lastDiff = diff.json;
    const lines: unknown = diff.json?.data?.lines;
    assert.ok(Array.isArray(lines), `snapshot diff has no lines: ${JSON.stringify(diff.json)}`);
    const reported = lines.filter(isSnapshotDiffLine);
    missing = missing.filter(
      (line) => !reported.some((seen) => seen.kind === line.kind && seen.text.includes(line.text)),
    );
    if (missing.length === 0) return;
    const pause = Math.min(SNAPSHOT_TRANSITION_POLL_MS, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  const unreported = missing.map((line) => `${line.kind} line containing ${line.text}`).join(', ');
  assert.fail(
    `expected ${unreported} within ${SNAPSHOT_TRANSITION_TIMEOUT_MS}ms: ${JSON.stringify(lastDiff)}`,
  );
}

function isSnapshotDiffLine(value: unknown): value is SnapshotDiffLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Partial<SnapshotDiffLine>;
  return (
    (line.kind === 'added' || line.kind === 'removed' || line.kind === 'unchanged') &&
    typeof line.text === 'string'
  );
}
