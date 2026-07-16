/**
 * #1271 stage 2 (ADR 0012 decision 6 amendment): the repair-segment default
 * exclusion of observation-only commands, and the `--record` opt-in that
 * forces one back in.
 *
 * Provider-backed rather than a handler unit test on purpose: the exclusion is
 * a DAEMON-side recording contract every surface inherits, so it has to be
 * proven through the real request router, session store, replay runtime, and
 * script writer — only the device provider is faked. The counterpart
 * `--no-record` coverage lives in `android-lifecycle.test.ts`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/index.ts';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { androidSettingsXml, androidSnapshotHelperOutput } from './android-world.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';

const SEARCH_SELECTOR = 'id=com.android.settings:id/search';

test('Provider-backed integration: a repair-armed segment excludes diagnostic reads by default and --record forces the corrective read into the heal', async () => {
  const adbProvider: AndroidAdbProvider = {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    exec: async (args) => androidRepairAdbResult(args),
  };
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => adbProvider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-repair-record-exclusion-'));

  try {
    const client = daemon.client();
    const selection = { platform: 'android' as const, serial: PROVIDER_SCENARIO_ANDROID.id };

    const open = await client.apps.open({ app: 'settings', ...selection });
    assert.equal(open.device?.id, PROVIDER_SCENARIO_ANDROID.id);

    // Step 2 diverges: a selector that matches nothing in the current tree.
    // Step 3 is an AUTHORED observation, deliberately `is visible` — a
    // different command from the interactive `get` reads below, so the healed
    // script is unambiguous about which line came from where.
    const repairPath = path.join(tempRoot, 'repair.ad');
    fs.writeFileSync(
      repairPath,
      ['snapshot -i', 'press label="NoSuchControl"', `is visible ${SEARCH_SELECTOR}`, ''].join(
        '\n',
      ),
    );

    // --- Arm the repair transaction (R1): `replay --save-script` before step 1. ---
    const divergenceError = await client.replay
      .run({ path: repairPath, saveScript: true, ...selection })
      .then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
    assert.ok(divergenceError, 'expected the armed replay to diverge on the missing selector');
    assert.equal(divergenceError.code, 'REPLAY_DIVERGENCE');
    const divergenceReport = divergenceError.details?.divergence as {
      resume: { allowed: boolean; from: number; planDigest: string; repairSessionHeld?: boolean };
    };
    assert.equal(divergenceReport.resume.allowed, true);
    // R7/C1: the divergence reports the repair transaction as held — the exact
    // signal the #1271 stage-1 guidance clause is gated on.
    assert.equal(divergenceReport.resume.repairSessionHeld, true);
    // The session is repair-armed: `saveScriptBoundary` is the boundary the
    // exclusion keys off (an ordinary `open --save-script` never sets it).
    const armedBoundary = daemon.session()?.saveScriptBoundary;
    assert.equal(typeof armedBoundary, 'number');

    // --- The exclusion contrast: the SAME observation-only command, against the
    // same selector, run twice inside the repair segment — differing only in
    // `--record`. ---
    const actionsBeforeReads = daemon.session()?.actions.length ?? 0;

    // (a) A diagnostic read used to LOCATE the target: excluded by default,
    //     with no `--no-record` needed (the #1271 stage-1 foot-gun).
    const diagnosticRead = await daemon.callCommand('get', ['text', SEARCH_SELECTOR], {
      ...selection,
    });
    assertRpcOk(diagnosticRead);
    assert.equal(
      daemon.session()?.actions.length,
      actionsBeforeReads,
      'a diagnostic read inside a repair segment must not be recorded',
    );

    // (b) The corrective read (the wave-3 E3 shape: the diverged step is itself
    //     a read), forced into the heal with `--record`.
    const correctiveRead = await daemon.callCommand('get', ['text', SEARCH_SELECTOR], {
      ...selection,
      record: true,
    });
    assertRpcOk(correctiveRead);
    const armedActions = daemon.session()?.actions ?? [];
    assert.equal(armedActions.length, actionsBeforeReads + 1);
    assert.equal(armedActions.at(-1)?.command, 'get');

    // (c) `--record` and `--no-record` are opposite intents for one action.
    const conflictingFlags = await daemon.callCommand('get', ['text', SEARCH_SELECTOR], {
      ...selection,
      record: true,
      noRecord: true,
    });
    assertRpcError(conflictingFlags, 'INVALID_ARGS', /--record and --no-record are mutually/);

    // --- Resume past the diverged step, completing the plan (transaction COMPLETE). ---
    const resumed = await client.replay.run({
      path: repairPath,
      resumeFrom: divergenceReport.resume.from + 1,
      resumePlanDigest: divergenceReport.resume.planDigest,
      ...selection,
    });
    assert.equal(resumed.replayed, 1);

    // --- Commit the heal and read what actually landed on disk. ---
    const close = await daemon.callCommand('close', [], { saveScript: true });
    assertRpcOk(close);
    const healedPath = path.join(tempRoot, 'repair.healed.ad');
    assert.equal(fs.existsSync(healedPath), true, 'the completed repair must publish a healed .ad');
    const healedScript = fs.readFileSync(healedPath, 'utf8');

    // The heal carries EXACTLY ONE `get` line: the `--record`ed corrective
    // read. The identical diagnostic read that ran first is absent — the whole
    // point of the amendment, and the reason a blanket read-exclusion would be
    // unsafe (it would drop this line too, silently).
    const getLines = healedLines(healedScript, 'get');
    assert.equal(getLines.length, 1, `expected exactly one recorded get, got:\n${healedScript}`);
    assert.match(getLines[0]!, /com\.android\.settings:id\/search/);

    // PROVENANCE (the rule the exclusion actually keys off): the AUTHORED
    // `is visible` plan step must survive into its own healed script. It is
    // the same command class as the excluded diagnostic read above and carries
    // no `--record`, so a command-class exclusion would silently drop it —
    // leaving a healed flow that quietly stopped asserting what the original
    // asserted. Users must never have to annotate their own `.ad` steps.
    const isLines = healedLines(healedScript, 'is');
    assert.equal(
      isLines.length,
      1,
      `the authored 'is visible' step must survive the heal, got:\n${healedScript}`,
    );
    assert.match(isLines[0]!, /com\.android\.settings:id\/search/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    await daemon.close();
  }
  // Matches the provider-scenario convention (android-lifecycle uses the same
  // budget): this drives a full arm -> diverge -> resume -> commit chain.
}, 15_000);

/** Recorded action lines for one command, ignoring the context header, `target-v1` annotations, and the sentinel. */
function healedLines(script: string, command: string): string[] {
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === command || line.startsWith(`${command} `));
}

function androidRepairAdbResult(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  if (args.join(' ') === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (args.join(' ') === 'shell dumpsys window windows') {
    return {
      stdout: 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (args.join(' ').startsWith('shell am instrument ')) {
    return {
      stdout: androidSnapshotHelperOutput(androidSettingsXml('Display')),
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}
