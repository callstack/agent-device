import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  openFixture,
  pressFixtureTarget,
  scrollFixtureSetup,
  snapshotFixture,
  type CliContext,
} from '../ios-snapshot-benchmark/command.ts';
import { screenFixture } from '../ios-snapshot-benchmark/definitions.ts';
import {
  fixtureOperationFromCli,
  prepareFixture,
  requireFixtureOperationSuccess,
} from '../ios-snapshot-benchmark/fixture-admission.ts';
import { readRunningAppPids, stopDaemon } from '../ios-snapshot-benchmark/lifecycle.ts';
import { closeSession } from '../ios-snapshot-benchmark/local-runner.ts';
import { createGuestSimulatorFrameworkBridgeAdapter } from './guest-adapter.ts';
import { awaitAppReadiness } from './targeted-readiness.ts';
import { adapterOptions, missingResponse, targetedRequest } from './targeted-request.ts';
import type { SpikeConfig } from './config.ts';
import type { TargetedRelaunchSample } from './corrected-types.ts';
import type { ScreenFixture, ScreenId } from '../ios-snapshot-benchmark/types.ts';

const RELAUNCH_SAMPLES = 20;
const SCREENS: readonly ScreenId[] = [
  'quiet',
  'list',
  'nested-scroll',
  'alert',
  'system-surface',
  'xctest-stress',
];

export async function runTargetedRelaunch(
  config: SpikeConfig,
): Promise<readonly TargetedRelaunchSample[]> {
  const samples: TargetedRelaunchSample[] = [];
  for (const screen of SCREENS) {
    samples.push(...(await runScreen(config, screen)));
  }
  return samples;
}

async function runScreen(
  config: SpikeConfig,
  screen: ScreenId,
): Promise<readonly TargetedRelaunchSample[]> {
  const fixture = screenFixture(screen);
  const expectedAnchor = fixture.postSetupAnchorText ?? fixture.anchorText;
  const context = contextFor(config, screen);
  const adapter = createGuestSimulatorFrameworkBridgeAdapter(adapterOptions(config));
  const samples: TargetedRelaunchSample[] = [];
  let previousPid: number | undefined;
  try {
    for (let index = 1; index <= RELAUNCH_SAMPLES; index += 1) {
      await prepareRelaunch(context, fixture, screen);
      const appPid = exactAppPid(config.udid, fixture.app);
      assertNewPid(previousPid, appPid, screen);
      previousPid = appPid;
      samples.push(await captureRelaunch(config, adapter, screen, expectedAnchor, appPid, index));
    }
    return samples;
  } finally {
    await adapter.close?.();
    closeSession(context);
    stopDaemon(config.repoRoot, config.stateDir);
  }
}

async function prepareRelaunch(
  context: CliContext,
  fixture: ScreenFixture,
  screen: ScreenId,
): Promise<void> {
  const opened = openFixture(context, fixture, { relaunch: true });
  requireFixtureOperationSuccess(
    fixtureOperationFromCli(opened, `relaunch ${screen} setup`),
    `relaunch ${screen} setup`,
    'cell-state',
  );
  await prepareFixture(fixture, {
    observe: () => fixtureOperationFromCli(snapshotFixture(context), 'fixture snapshot'),
    scrollToBottom: () =>
      fixtureOperationFromCli(scrollFixtureSetup(context), 'fixture scroll bottom'),
    openAlert: () =>
      fixtureOperationFromCli(
        pressFixtureTarget(context, 'id="automation-open-alert"'),
        'fixture open alert',
      ),
  });
}

async function captureRelaunch(
  config: SpikeConfig,
  adapter: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>,
  screen: ScreenId,
  expectedAnchor: string,
  appPid: number,
  index: number,
): Promise<TargetedRelaunchSample> {
  const readiness = await awaitAppReadiness(config, appPid, screen, expectedAnchor);
  const id = `relaunch-${screen}-${index}`;
  const started = performance.now();
  const result = await adapter.acquireBatch([
    targetedRequest(config, id, {
      state: 'relaunch',
      screen,
      expectedTargetGeneration: `pid:${appPid}`,
    }),
  ]);
  return {
    index,
    screen,
    expectedAnchor,
    appPid,
    readinessMs: readiness.readinessMs,
    readinessAttempts: readiness.attempts,
    durationMs: performance.now() - started,
    response: result.responses[0] ?? missingResponse(id),
    stderr: result.stderr,
  };
}

function assertNewPid(previousPid: number | undefined, appPid: number, screen: ScreenId): void {
  if (previousPid !== appPid) return;
  throw new Error(`Relaunch ${screen} reused app pid ${appPid}.`);
}

function exactAppPid(udid: string, appId: string): number {
  const pids = readRunningAppPids(udid, appId);
  if (pids.length !== 1) {
    throw new Error(
      `Expected one ${appId} process on ${udid}, observed ${pids.join(', ') || 'none'}.`,
    );
  }
  return pids[0]!;
}

function contextFor(config: SpikeConfig, screen: ScreenId): CliContext {
  return {
    repoRoot: config.repoRoot,
    stateDir: config.stateDir,
    session: `ax-bridge-relaunch-${screen}`,
    udid: config.udid,
    derivedPath: path.join(config.derivedPath, screen),
  };
}

export const TARGETED_RELAUNCH_SCREENS = SCREENS;
export const TARGETED_RELAUNCH_SAMPLES = RELAUNCH_SAMPLES;
