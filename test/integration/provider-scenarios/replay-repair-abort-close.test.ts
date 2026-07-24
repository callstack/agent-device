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

test('Provider-backed integration: repair close paths (abort, plain close, committed)', async () => {
  const adbProvider: AndroidAdbProvider = {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    exec: async (args) => androidRepairAdbResult(args),
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-repair-close-'));
  const repairPath = path.join(tempRoot, 'repair.ad');
  fs.writeFileSync(
    repairPath,
    ['snapshot -i', 'press label="NoSuchControl"', `is visible ${SEARCH_SELECTOR}`, ''].join('\n'),
  );

  // Helper to get divergence report
  async function armRepair(client: any, selection: any) {
    const open = await client.apps.open({ app: 'settings', ...selection });
    assert.equal(open.device?.id, PROVIDER_SCENARIO_ANDROID.id);

    const divergenceError = await client.replay
      .run({ path: repairPath, saveScript: true, ...selection })
      .then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
    assert.ok(divergenceError);
    return divergenceError.details?.divergence as {
      resume: { allowed: boolean; from: number; planDigest: string; repairSessionHeld?: boolean };
    };
  }

  try {
    // 1. Aborted repair with close --save-script fails and leaves no artifact
    let daemon = await createProviderScenarioHarness({
      androidAdbProvider: () => adbProvider,
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    });
    let client = daemon.client();
    const selection = { platform: 'android' as const, serial: PROVIDER_SCENARIO_ANDROID.id };

    await armRepair(client, selection);

    const abortedClose = await daemon.callCommand('close', [], { saveScript: true });
    assertRpcError(abortedClose, 'COMMAND_FAILED', /repair was aborted/);
    assert.equal(fs.existsSync(path.join(tempRoot, 'repair.healed.ad')), false);
    assert.equal(daemon.session(), undefined);
    await daemon.close();

    // 2. Aborted repair with plain close succeeds and leaves no artifact
    daemon = await createProviderScenarioHarness({
      androidAdbProvider: () => adbProvider,
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    });
    client = daemon.client();

    await armRepair(client, selection);

    const plainClose = await daemon.callCommand('close', []);
    assertRpcOk(plainClose);
    assert.equal(fs.existsSync(path.join(tempRoot, 'repair.healed.ad')), false);
    assert.equal(daemon.session(), undefined);
    await daemon.close();

    // 3. Committed repair with close --save-script succeeds and writes artifact
    daemon = await createProviderScenarioHarness({
      androidAdbProvider: () => adbProvider,
      deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
    });
    client = daemon.client();

    const divergenceReport = await armRepair(client, selection);

    const resumed = await client.replay.run({
      path: repairPath,
      resumeFrom: divergenceReport.resume.from + 1,
      resumePlanDigest: divergenceReport.resume.planDigest,
      ...selection,
    });
    assert.equal(resumed.replayed, 1);

    const committedClose = await daemon.callCommand('close', [], { saveScript: true });
    assertRpcOk(committedClose);
    assert.equal(fs.existsSync(path.join(tempRoot, 'repair.healed.ad')), true);
    assert.equal(daemon.session(), undefined);
    await daemon.close();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}, 30_000);

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
