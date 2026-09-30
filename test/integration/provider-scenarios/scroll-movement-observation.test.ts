import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import type { SimulatorSnapshotSource } from '@agent-device/platform-apple/snapshot-source';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from './providers.ts';
import { createProviderTranscript, type ProviderScenarioProviderEntry } from './transcript.ts';

// The Simulator AX bridge runs on the host toolchain, outside every provider this scenario scripts:
// on a host with Xcode it builds, spawns, and connects for real before failing, which costs each
// test seconds of wall time. Here it reports unavailable at once, so every capture takes the
// scripted runner, as it does on a host without Xcode.
vi.mock(
  '@agent-device/platform-apple/snapshot-source',
  (): { createSimulatorSnapshotSource: () => SimulatorSnapshotSource } => ({
    createSimulatorSnapshotSource: () => ({
      acquire: async () => ({
        stage: 'failed',
        failure: { kind: 'unsupported', code: 'provider-scenario-no-bridge' },
      }),
      close: async () => {},
    }),
  }),
);

const APP = 'com.example.app';
const DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

// Directional-scroll observation on `observeUntil` (packages/capture-kit/src/observe-until.ts):
// `scroll down` gates its own `movement` claim on the tree it held before the gesture against one
// (or more, while the surface still looks untouched) post-gesture capture. The unit-level coverage
// in src/daemon/__tests__/scroll-movement.test.ts pins the verdict against a scripted capture
// function directly; these two scenarios drive the SAME loop end to end through the daemon's real
// command routing and a scripted Apple runner, the way `settle-observation.test.ts` drives `--settle`.

// Fixed tab-bar-free list: a ScrollView reporting hidden content below, holding two rows. `rowOffset`
// moves the rows to model a scroll that actually shifted content; `hiddenBelow` toggles whether the
// container still reports more to reveal, which is what the no-progress refusal keys on.
const CONTAINER = { x: 18, y: 178, width: 366, height: 662 };

function screen(rowOffset: number, hiddenBelow: boolean) {
  return [
    {
      index: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'lab-list',
      rect: CONTAINER,
      ...(hiddenBelow ? { hiddenContentBelow: true } : {}),
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Row one',
      // 300 (+ up to -100 offset) stays inside CONTAINER's clip (y 178..840): the presentation
      // validator refuses a child frame that escapes its container's cumulative clip.
      rect: { x: 24, y: 300 + rowOffset, width: 300, height: 20 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Row two',
      rect: { x: 24, y: 360 + rowOffset, width: 300, height: 20 },
    },
  ];
}

function snapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { nodes, truncated: false },
  };
}

// A UI that never moves: every post-gesture capture returns the same tree, so the loop can never
// see a quiet-then-still-hidden pair on a fixed count. How many captures it takes to prove that is
// wall-clock (200ms poll floor), so the count is not scripted — a repeat entry serves every call.
function repeatSnapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return { ...snapshotEntry(nodes), repeat: true };
}

// Midpoint (201, 437) sits inside CONTAINER, matching the swipe fixture
// `src/daemon/__tests__/scroll-movement.test.ts` uses for the same geometry.
function scrollEntry(): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.scroll',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { x: 201, y: 487, x2: 201, y2: 387 },
  };
}

/**
 * The route ahead of a directional scroll's own capture resolves a live simulator target (a real
 * host process lookup) before it ever reaches the scripted runner, so a bare `simctlDeviceLifecycleHandler`
 * leaves every capture with a fresh, per-call "unknown generation" identity — comparable to nothing,
 * which is `capture-lineage-drift` on the very first post-gesture read. Naming one fixed, stable
 * "running app" job (a `launchctl list` line) and a fixed process start time (`ps -p <pid> -o lstart=`)
 * lets the route resolve ONE identity and reuse it every capture, exactly like a real simulator whose
 * app process never restarts mid-scroll — the AX bridge itself still isn't modeled, so every capture
 * still falls back to the scripted runner, carrying that one stable identity instead of a random one.
 */
function iosSimulatorTool(): { provider: AppleToolProvider } {
  const baseSimctl = simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
    { name: PROVIDER_SCENARIO_IOS_SIMULATOR.name, udid: DEVICE_ID },
  ]);
  const recorded = createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      if (args[0] === 'spawn' && args[1] === DEVICE_ID && args[2] === 'launchctl') {
        return { stdout: `4242\t0\tUIKitApplication:${APP}[0x1]\n`, stderr: '', exitCode: 0 };
      }
      return await baseSimctl(args, options);
    },
  });
  const runCommand = async (
    cmd: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    // The system-surface presence probe runs before target resolution: report every
    // registered host absent so the route proceeds to resolve the (scripted) app target below,
    // instead of reading the probe as 'unknown' and falling back with a fresh random identity.
    if (cmd === 'pgrep') return { stdout: '', stderr: '', exitCode: 1 };
    if (cmd === 'ps' && args[0] === '-p') {
      return { stdout: 'Thu Jan  1 00:00:00 1970\n', stderr: '', exitCode: 0 };
    }
    return await recorded.provider.runCommand(cmd, args, options);
  };
  return { provider: { ...recorded.provider, runCommand } };
}

test('Provider-backed integration scroll down answers moved on the first post-gesture capture', async () => {
  const runnerTranscript = createProviderTranscript([
    snapshotEntry(screen(0, true)), // pre-scroll baseline
    scrollEntry(),
    snapshotEntry(screen(-100, true)), // post-gesture: rows shifted into view on the first read
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  const appleTool = iosSimulatorTool();

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      }),
    async (daemon) => {
      assertRpcOk(await daemon.callCommand('open', [APP], { platform: 'ios', udid: DEVICE_ID }));
      assertRpcOk(await daemon.callCommand('snapshot'));

      const callsBeforeScroll = runnerTranscript.calls.length;
      const scroll = await daemon.callCommand('scroll', ['down']);
      const scrollData = assertRpcOk<{ movement?: string }>(scroll);

      assert.equal(scrollData.movement, 'moved');
      // Gesture first, then exactly one post-gesture snapshot: a scroll that worked is confirmed by
      // the cheapest possible read, and the order proves the read followed the gesture rather than
      // racing it.
      assert.deepEqual(
        runnerTranscript.calls.slice(callsBeforeScroll).map((call) => call.command),
        ['ios.runner.scroll', 'ios.runner.snapshot'],
      );

      runnerTranscript.assertComplete();
    },
  );
});

test('Provider-backed integration scroll down that never moves a hidden-content container refuses with scroll_no_progress', async () => {
  const runnerTranscript = createProviderTranscript([
    snapshotEntry(screen(0, true)), // pre-scroll baseline
    scrollEntry(),
    // Every post-gesture read is byte-identical to the baseline and the container still reports
    // hidden content below: the gesture never reached it.
    repeatSnapshotEntry(screen(0, true)),
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  const appleTool = iosSimulatorTool();

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      }),
    async (daemon) => {
      assertRpcOk(await daemon.callCommand('open', [APP], { platform: 'ios', udid: DEVICE_ID }));
      assertRpcOk(await daemon.callCommand('snapshot'));

      const callsBeforeScroll = runnerTranscript.calls.length;
      const scroll = await daemon.callCommand('scroll', ['down']);
      const errorData = assertRpcError(scroll, 'COMMAND_FAILED', /scroll down moved nothing/);
      assert.equal(
        errorData.details && (errorData.details as Record<string, unknown>).reason,
        'scroll_no_progress',
      );

      const callsDuringScroll = runnerTranscript.calls.slice(callsBeforeScroll);
      // Gesture first, then at least the quiet-pair minimum of post-gesture snapshots — an exact
      // count would assert the loop's polling speed rather than the refusal itself.
      assert.equal(callsDuringScroll[0]?.command, 'ios.runner.scroll');
      assert.ok(
        callsDuringScroll.filter((call) => call.command === 'ios.runner.snapshot').length >= 2,
        `expected at least two post-gesture captures, saw ${callsDuringScroll.length - 1}`,
      );
    },
  );
});
