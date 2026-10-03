import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCmd, type ExecResult } from '@agent-device/host-kit/command';
import type { LiveContext } from './live-harness.ts';

const CLI_TIMEOUT_MS = 120_000;
const UI_TRANSITION_SETTLE_MS = 500;
const MAX_SNAPSHOT_ATTEMPTS = 4;

/**
 * Exercises compact human output on the one built-in comparison-safe capture: an unfiltered
 * Android snapshot. The route change is sent through adb so no Agent Device observation can
 * replace the baseline before the following snapshot proves that changed content reprints.
 */
export async function assertHumanSnapshotCompaction(context: LiveContext): Promise<void> {
  const evidence: { command: string; result: ExecResult }[] = [];
  try {
    const baseline = await runSnapshot(context, ['--force-full'], evidence);
    assertFullSnapshot(baseline.stdout ?? '', 'forced baseline');

    const { baseline: stableBaseline, unchanged } = await readUntilCompact(
      context,
      baseline,
      evidence,
    );
    assert.doesNotMatch(
      unchanged.stdout ?? '',
      /@e\d+/,
      'compact output must not re-emit element refs',
    );
    assert.ok(
      Buffer.byteLength(unchanged.stdout ?? '') < Buffer.byteLength(stableBaseline.stdout ?? ''),
      'compact output should be smaller than the full tree',
    );

    const forced = await runSnapshot(context, ['--force-full'], evidence);
    assertFullSnapshot(forced.stdout ?? '', 'forced repeat');

    const back = await runCmd(
      'adb',
      ['-s', context.serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'],
      {
        allowFailure: true,
        env: context.env,
        timeoutMs: CLI_TIMEOUT_MS,
      },
    );
    evidence.push({ command: 'adb shell input keyevent KEYCODE_BACK', result: back });
    assert.equal(back.exitCode, 0, `external Android Back failed: ${back.stderr ?? ''}`);

    const changed = await readUntilChangedRoute(context, evidence);

    console.log(
      `Android human snapshot compaction passed: full=${Buffer.byteLength(stableBaseline.stdout ?? '')}B, compact=${Buffer.byteLength(unchanged.stdout ?? '')}B, forced=${Buffer.byteLength(forced.stdout ?? '')}B, changed=${Buffer.byteLength(changed.stdout ?? '')}B`,
    );
  } finally {
    fs.writeFileSync(
      path.join(context.artifactDir, 'snapshot-compaction.txt'),
      evidence
        .map(({ command, result }) =>
          [`$ ${command}`, result.stdout ?? '', result.stderr ?? ''].filter(Boolean).join('\n'),
        )
        .join('\n\n'),
    );
  }
}

async function readUntilCompact(
  context: LiveContext,
  initialBaseline: ExecResult,
  evidence: { command: string; result: ExecResult }[],
): Promise<{ baseline: ExecResult; unchanged: ExecResult }> {
  let baseline = initialBaseline;
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const current = await runSnapshot(context, [], evidence);
    if (/^Snapshot unchanged since previous read /m.test(current.stdout ?? '')) {
      return { baseline, unchanged: current };
    }
    assertFullSnapshot(current.stdout ?? '', `comparison attempt ${attempt.toString()}`);
    baseline = current;
  }
  assert.fail(`no identical Android snapshot compacted after ${MAX_SNAPSHOT_ATTEMPTS} attempts`);
}

async function readUntilChangedRoute(
  context: LiveContext,
  evidence: { command: string; result: ExecResult }[],
): Promise<ExecResult> {
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const current = await runSnapshot(context, [], evidence);
    if (/Open automation lab/.test(current.stdout ?? '')) {
      assertFullSnapshot(current.stdout ?? '', 'changed route');
      return current;
    }
    if (attempt < MAX_SNAPSHOT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, UI_TRANSITION_SETTLE_MS));
    }
  }
  assert.fail(
    `the externally changed Android route was not visible after ${MAX_SNAPSHOT_ATTEMPTS} attempts`,
  );
}

async function runSnapshot(
  context: LiveContext,
  extraArgs: string[],
  evidence: { command: string; result: ExecResult }[],
): Promise<ExecResult> {
  const args = [
    'bin/agent-device.mjs',
    'snapshot',
    ...extraArgs,
    '--platform',
    'android',
    '--serial',
    context.serial,
    '--session',
    context.session,
    '--daemon-server-mode',
    'dual',
  ];
  const result = await runCmd(process.execPath, args, {
    allowFailure: true,
    env: context.env,
    timeoutMs: CLI_TIMEOUT_MS,
  });
  evidence.push({ command: `agent-device ${args.slice(1).join(' ')}`, result });
  assert.equal(result.exitCode, 0, `human snapshot failed: ${result.stderr ?? ''}`);
  return result;
}

function assertFullSnapshot(output: string, description: string): void {
  assert.match(
    output,
    /^Snapshot: \d+(?: visible)? nodes?(?: \(\d+ total\))?(?: \(truncated\))?$/m,
    `${description} should print a tree header`,
  );
  assert.match(output, /@e\d+/, `${description} should print element refs`);
  assert.doesNotMatch(output, /snapshot unchanged/i, `${description} must not compact`);
}
