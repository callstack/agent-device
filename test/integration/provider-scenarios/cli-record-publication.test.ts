import fs from 'node:fs';
import path from 'node:path';
import { expect, test, onTestFinished } from 'vitest';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
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
    const transport: AgentDeviceDaemonTransport = async (req) => {
      const result = await daemon.callCommand(req.command, req.positionals, {
        ...req.flags,
        ...selection,
      });
      return result.json.error
        ? { ok: false, error: result.json.error.data }
        : { ok: true, data: result.json.result.data };
    };
    return {
      transport,
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
  'CLI project record default retains a repair snapshot only with explicit opt-in=%s',
  async (explicit) => {
    const { root, home, project } = makeTempWorkspace();
    fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
    const publication = await repairPublication(root);
    onTestFinished(() => publication.close());
    const result = await runCliCapture(['snapshot', '--json', ...(explicit ? ['--record'] : [])], {
      cwd: project,
      env: { HOME: home, USERPROFILE: home },
      sendToDaemon: publication.transport,
    });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.flags?.record).toBe(true);
    expect(await publication.commands()).toEqual(
      explicit ? ['snapshot', 'snapshot', 'is', 'close'] : ['snapshot', 'is', 'close'],
    );
  },
);

test.each([false, true])(
  'MCP project record default retains a repair snapshot only with explicit opt-in=%s',
  async (explicit) => {
    const { root, home, project } = makeTempWorkspace();
    fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
    const publication = await repairPublication(root);
    onTestFinished(() => publication.close());
    const restoreEnv = installIsolatedCliTestEnv({ HOME: home, USERPROFILE: home });
    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const executor = createCommandToolExecutor({
        createClient: (config, ingress) =>
          createAgentDeviceClient(config, { ...ingress, transport: publication.transport }),
      });
      const result = await executor.execute('snapshot', explicit ? { record: true } : {});
      expect(result.isError).toBe(false);
      expect(await publication.commands()).toEqual(
        explicit ? ['snapshot', 'snapshot', 'is', 'close'] : ['snapshot', 'is', 'close'],
      );
    } finally {
      process.chdir(previousCwd);
      restoreEnv();
    }
  },
);

test('SDK per-call record explicitly retains a corrective snapshot', async () => {
  const { root } = makeTempWorkspace();
  const publication = await repairPublication(root);
  onTestFinished(() => publication.close());
  const client = createAgentDeviceClient({}, { transport: publication.transport });
  await client.capture.snapshot({ record: true });
  expect(await publication.commands()).toEqual(['snapshot', 'snapshot', 'is', 'close']);
});
