import fs from 'node:fs';
import path from 'node:path';
import { expect, test, onTestFinished, vi } from 'vitest';
import * as codeSignature from '@agent-device/host-kit/code-signature';
import { resolveLocalDaemonCodeIdentity } from '../../../src/daemon-client/daemon-launch-spec.ts';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { createProviderScenarioHarness } from './harness.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/android-snapshot-helper.ts';
import {
  createAndroidProviderShellState,
  updateAndroidProviderImeShellState,
} from './android-ime-lifecycle-world.ts';
import { androidRepairAdbResult } from './replay-repair-world.ts';
import { runCliCapture } from '../../../src/__tests__/cli-capture.ts';
import { makeTempWorkspace } from '../../../src/__tests__/cli-config-fixtures.ts';
import { createAgentDeviceClient } from '../../../src/agent-device-client.ts';
import { createCommandToolExecutor } from '../../../src/mcp/command-tools.ts';
import { installIsolatedCliTestEnv } from '../../../src/__tests__/cli-test-env.ts';

async function repairPublication(root: string) {
  // The runtime runs inside Vitest, so publish the daemon entry's identity instead of Vitest's.
  const identity = await resolveLocalDaemonCodeIdentity();
  if (identity.origin !== 'checkout') throw new Error('expected checkout identity');
  const signature = vi
    .spyOn(codeSignature, 'resolveDaemonCodeSignature')
    .mockReturnValue(identity.codeSignature);
  onTestFinished(() => signature.mockRestore());
  const shellState = createAndroidProviderShellState();
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
      exec: async (args) => {
        updateAndroidProviderImeShellState(args, shellState);
        return androidRepairAdbResult(args, shellState);
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  const selection = { platform: 'android' as const, serial: PROVIDER_SCENARIO_ANDROID.id };
  const client = daemon.client();
  try {
    await client.apps.open({ app: 'settings', ...selection });
    const repairPath = path.join(root, 'repair.ad');
    fs.writeFileSync(
      repairPath,
      'snapshot -i\npress label="NoSuchControl"\nis visible id=com.android.settings:id/search\n',
    );
    const divergence = await client.replay
      .run({ path: repairPath, saveScript: true, ...selection })
      .then(
        () => {
          throw new Error('expected repair divergence');
        },
        (error: {
          details: {
            divergence: {
              resume: { from: number; planDigest: string; repairSessionHeld: boolean };
            };
          };
        }) => error.details.divergence.resume,
      );
    expect(divergence.repairSessionHeld).toBe(true);
    return {
      config: { stateDir: daemon.stateDir, daemonTransport: 'http' as const, ...selection },
      close: () => daemon.close(),
      commands: async () => {
        await client.replay.run({
          path: repairPath,
          resumeFrom: divergence.from + 1,
          resumePlanDigest: divergence.planDigest,
          ...selection,
        });
        await client.apps.close({ saveScript: true });
        return parseReplayScriptDetailed(
          fs.readFileSync(path.join(root, 'repair.healed.ad'), 'utf8'),
        ).actions.map((action) => action.command);
      },
    };
  } catch (error) {
    await daemon.close();
    throw error;
  }
}

test.each([false, true])(
  'CLI keeps a corrective snapshot only with an explicit --record, not with a retired record config key=%s',
  async (explicit) => {
    const { root, home, project } = makeTempWorkspace();
    const publication = await repairPublication(root);
    fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
    onTestFinished(() => publication.close());
    const result = await runCliCapture(
      [
        'snapshot',
        '--json',
        '--session',
        'default',
        '--state-dir',
        publication.config.stateDir,
        '--daemon-transport',
        'http',
        '--platform',
        'android',
        '--serial',
        publication.config.serial,
        ...(explicit ? ['--record'] : []),
      ],
      {
        cwd: project,
        env: { HOME: home, USERPROFILE: home },
        useRealDaemonClient: true,
      },
    );
    // The retired project-config key fails closed with migration guidance, so the
    // explicit `--record` call never reaches the repair session either.
    expect(result.code).toBe(1);
    const failureOutput = `${result.stdout}${result.stderr}`;
    expect(failureOutput).toMatch(/\\"record\\" in project config file .* was removed/);
    expect(failureOutput).toMatch(/--record is per-invocation only/);
  },
);

test('CLI keeps an explicitly recorded corrective snapshot with no config key present', async () => {
  const { root, home, project } = makeTempWorkspace();
  const publication = await repairPublication(root);
  onTestFinished(() => publication.close());
  const result = await runCliCapture(
    [
      'snapshot',
      '--json',
      '--session',
      'default',
      '--state-dir',
      publication.config.stateDir,
      '--daemon-transport',
      'http',
      '--platform',
      'android',
      '--serial',
      publication.config.serial,
      '--record',
    ],
    {
      cwd: project,
      env: { HOME: home, USERPROFILE: home },
      useRealDaemonClient: true,
    },
  );
  expect(result.code, result.stderr || result.stdout).not.toBe(1);
  expect(await publication.commands(), JSON.stringify(result)).toEqual([
    'snapshot',
    'snapshot',
    'is',
    'close',
  ]);
});

test.each([false, true])(
  'MCP keeps a corrective snapshot only with an explicit record input, not with a retired record config key=%s',
  async (explicit) => {
    const { root, home, project } = makeTempWorkspace();
    const publication = await repairPublication(root);
    fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
    onTestFinished(() => publication.close());
    const restoreEnv = installIsolatedCliTestEnv({
      HOME: home,
      USERPROFILE: home,
      AGENT_DEVICE_STATE_DIR: publication.config.stateDir,
      AGENT_DEVICE_DAEMON_TRANSPORT: 'http',
    });
    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const executor = createCommandToolExecutor();
      // Config resolution runs before the command and rejects the call with the
      // migration error, whether or not the tool input carries `record`.
      await expect(
        executor.execute('snapshot', {
          platform: 'android',
          serial: publication.config.serial,
          ...(explicit ? { record: true } : {}),
        }),
      ).rejects.toThrow(/"record" in project config file .* was removed/);
    } finally {
      process.chdir(previousCwd);
      restoreEnv();
    }
  },
);

test('MCP keeps an explicitly recorded corrective snapshot with no config key present', async () => {
  const { root, home, project } = makeTempWorkspace();
  const publication = await repairPublication(root);
  onTestFinished(() => publication.close());
  const restoreEnv = installIsolatedCliTestEnv({
    HOME: home,
    USERPROFILE: home,
    AGENT_DEVICE_STATE_DIR: publication.config.stateDir,
    AGENT_DEVICE_DAEMON_TRANSPORT: 'http',
  });
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    const executor = createCommandToolExecutor();
    const result = await executor.execute('snapshot', {
      platform: 'android',
      serial: publication.config.serial,
      record: true,
    });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(await publication.commands(), JSON.stringify(result)).toEqual([
      'snapshot',
      'snapshot',
      'is',
      'close',
    ]);
  } finally {
    process.chdir(previousCwd);
    restoreEnv();
  }
});

test('SDK per-call record explicitly retains a corrective snapshot', async () => {
  const { root } = makeTempWorkspace();
  const publication = await repairPublication(root);
  onTestFinished(() => publication.close());
  const client = createAgentDeviceClient(publication.config);
  await client.capture.snapshot({ record: true });
  expect(await publication.commands()).toEqual(['snapshot', 'snapshot', 'is', 'close']);
});
