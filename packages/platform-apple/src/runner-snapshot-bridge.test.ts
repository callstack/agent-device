import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AppleRunnerProvider, RunnerCommand } from '@agent-device/apple-runner';
import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';

const registry = vi.hoisted(() => ({
  session: undefined as { sessionId: string; liveness: 'ready' | 'starting' } | undefined,
}));
vi.mock('./core/runner-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./core/runner-client.ts')>()),
  readRunnerSessionLiveness: () => registry.session ?? null,
}));

import { createAppleRunnerRuntime } from './runner-runtime.ts';
import { createRunnerSnapshotBridge } from './runner-snapshot-bridge.ts';
import { createSnapshotBridgeRoute } from './snapshot-route.ts';
import { IOS_SIMULATOR } from './__tests__/device-fixtures.ts';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import {
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
} from './snapshot-source/protocol.ts';

const APP = 'com.example.app';

beforeEach(() => {
  registry.session = { sessionId: 'runner-session-1', liveness: 'ready' };
});

type RunnerProcess = { pid: number; processStartTime: string };

/**
 * A runner that serves the snapshot bridge like the XCTest runner does: `target` names the app's
 * foreground process, and `describe` reads it unless the host planned another process, or answers
 * the refusal `refuseDescribe` names. A describe given `holdNextDescribe` reads until that promise
 * settles, and, like the runner, it keeps reading after the daemon stops waiting: a describe that
 * arrives meanwhile is refused as `bridge-read-in-flight`. A describe that names surface hosts is
 * refused as `system-surface-host-unverified`, as a sandbox that refuses the process table does.
 */
function bridgeRunner(state: {
  process: RunnerProcess;
  refuseDescribe?: string;
  refuseTarget?: string;
  holdNextDescribe?: Promise<void>;
}) {
  const sent: RunnerCommand[] = [];
  let reading = false;
  const envelope = (request: NonNullable<RunnerCommand['snapshotBridge']>, body: object) => ({
    snapshotBridgeEnvelope: JSON.stringify({
      protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
      sourceVersion: SNAPSHOT_SOURCE_VERSION,
      requestId: request.requestId,
      ...body,
    }),
  });
  const provider: AppleRunnerProvider = {
    hasLiveSession: () => true,
    runCommand: async (_device, command, options) => {
      sent.push(command);
      const request = command.snapshotBridge;
      if (command.command !== 'snapshotBridge' || !request) return {};
      if (request.verb === 'target' && state.refuseTarget) {
        return envelope(request, {
          ok: false,
          error_kind: 'application_unavailable',
          error_code: state.refuseTarget,
        });
      }
      if (request.verb === 'target') return envelope(request, { ok: true, ...state.process });
      const refusal = (kind: string, code: string) =>
        envelope(request, {
          ok: false,
          pid: request.expectedPid,
          generation: request.generation,
          error_kind: kind,
          error_code: code,
        });
      if (
        request.expectedPid !== state.process.pid ||
        request.expectedProcessStartTime !== state.process.processStartTime
      ) {
        return refusal('stale_target', 'target-process-changed');
      }
      if (request.surfaceHostExecutables)
        return refusal('unsupported', 'system-surface-host-unverified');
      if (state.refuseDescribe) return refusal('application_not_responding', state.refuseDescribe);
      if (reading) return refusal('application_not_responding', 'bridge-read-in-flight');
      const hold = state.holdNextDescribe;
      if (hold) {
        state.holdNextDescribe = undefined;
        reading = true;
        void hold.then(() => {
          reading = false;
        });
        await new Promise<void>((resolve, reject) => {
          void hold.then(resolve);
          options.signal?.addEventListener('abort', () => reject(createRequestCanceledError()), {
            once: true,
          });
        });
      }
      return envelope(request, {
        ok: true,
        pid: state.process.pid,
        generation: request.generation,
        truncated: false,
        automationEnabled: true,
        recovery: {
          requests: 1,
          rejected: 0,
          continuations: 0,
          acceptedLevels: (request.maxDepth ?? 0) + 1,
        },
        tree: {
          XC_kAXXCAttributeElementType: 'Application',
          XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 390, Height: 844 },
          XC_kAXXCAttributeChildren: [
            {
              XC_kAXXCAttributeElementType: 'Button',
              XC_kAXXCAttributeLabel: 'Continue',
              XC_kAXXCAttributeFrame: { X: 10, Y: 10, Width: 80, Height: 40 },
              XC_kAXXCAttributeChildren: [],
            },
          ],
        },
      });
    },
  };
  return { provider, sent };
}

function runnerResult() {
  return { backend: 'xctest' as const, producer: 'apple-runner' as const, nodes: [] };
}

function verbs(sent: readonly RunnerCommand[]): string[] {
  return sent.map((command) => command.snapshotBridge?.verb ?? command.command);
}

/** The bridge route of a runner whose foreground read proves no system surface covers the app. */
function bridgeRoute(provider: AppleRunnerProvider) {
  const bridge = createRunnerSnapshotBridge({ device: IOS_SIMULATOR, provider });
  const presented: SnapshotRuntimeAcquiredResult[] = [];
  const fallbacks: CaptureSnapshotInput[] = [];
  const route = createSnapshotBridgeRoute(
    {
      snapshot: {
        presentIosAcquisition: (result) => {
          presented.push(result);
          return { ...runnerResult(), producer: result.acquisition.producer };
        },
      },
      appleApplications: { hasLiveRunnerSession: async () => true },
    },
    {
      source: bridge.source,
      resolveTarget: bridge.resolveTarget,
      isDiscoveryPending: () => false,
      targetFreshness: 'cached',
    },
    async () => 'background',
  );
  const snapshot = (signal = new AbortController().signal) =>
    route.capture(
      IOS_SIMULATOR,
      { options: { appBundleId: APP, interactiveOnly: true } },
      signal,
      async (input) => {
        fallbacks.push(input);
        return runnerResult();
      },
    );
  return { snapshot, presented, fallbacks };
}

test('a remote Simulator capture reads the runner-served bridge in one round trip once its target is known', async () => {
  const { provider, sent } = bridgeRunner({
    process: { pid: 41, processStartTime: '1700000000.000001' },
  });
  const { snapshot, presented, fallbacks } = bridgeRoute(provider);

  const first = await snapshot();
  await snapshot();

  expect(first.warnings ?? []).toEqual([]);
  expect(fallbacks).toEqual([]);
  expect(presented.map(({ acquisition }) => acquisition.producer)).toEqual([
    'simulator-ax-bridge',
    'simulator-ax-bridge',
  ]);
  expect(presented[0]!.acquisition.lineage).toEqual({
    targetId: `${IOS_SIMULATOR.id}:${APP}`,
    generation: '41:1700000000.000001',
  });
  expect(verbs(sent)).toEqual(['target', 'describe', 'describe']);
  expect(sent[1]!.snapshotBridge).toMatchObject({
    expectedPid: 41,
    expectedProcessStartTime: '1700000000.000001',
    generation: '41:1700000000.000001',
  });
});

test('every runner bridge request names its own budget, one transport margin under the daemon deadline', async () => {
  const { provider, sent } = bridgeRunner({
    process: { pid: 41, processStartTime: '1700000000.000001' },
  });
  const { snapshot } = bridgeRoute(provider);

  await snapshot();

  const [target, describe] = sent.map((command) => command.snapshotBridge);
  expect(target).toMatchObject({ verb: 'target', maxDurationMs: 4_000 });
  expect(describe).toMatchObject({ verb: 'describe', maxDurationMs: 4_000 });
  expect(describe!.maxResponseBytes).toBeGreaterThan(0);
});

test('a read that meets a relaunched app takes XCTest once and reads the new process next', async () => {
  const state = { process: { pid: 41, processStartTime: '1700000000.000001' } };
  const { provider, sent } = bridgeRunner(state);
  const { snapshot, presented, fallbacks } = bridgeRoute(provider);
  await snapshot();
  state.process = { pid: 77, processStartTime: '1700000100.000002' };
  sent.length = 0;

  const relaunched = await snapshot();
  await snapshot();

  expect(fallbacks).toHaveLength(1);
  expect(relaunched.warnings).toEqual([
    'Simulator AX snapshot unavailable (target-process-changed); used XCTest for this app generation.',
  ]);
  expect(presented.at(-1)!.acquisition.lineage.generation).toBe('77:1700000100.000002');
  expect(verbs(sent)).toEqual(['describe', 'target', 'describe']);
});

test('a relaunch re-enables the bridge that a failed read disabled for the old generation', async () => {
  const state: { process: RunnerProcess; refuseDescribe?: string } = {
    process: { pid: 41, processStartTime: '1700000000.000001' },
    refuseDescribe: 'bridge-read-abandoned',
  };
  const { provider, sent } = bridgeRunner(state);
  const { snapshot, presented, fallbacks } = bridgeRoute(provider);
  await snapshot();
  await snapshot();
  expect(fallbacks).toHaveLength(2);
  expect(presented).toEqual([]);

  state.process = { pid: 77, processStartTime: '1700000100.000002' };
  state.refuseDescribe = undefined;
  sent.length = 0;
  await snapshot();

  // The open circuit sends no read that could meet the new process, so the route asks for the target
  // again before it trusts the circuit.
  expect(fallbacks).toHaveLength(2);
  expect(presented.at(-1)!.acquisition.lineage.generation).toBe('77:1700000100.000002');
  expect(verbs(sent)).toEqual(['target', 'describe']);
});

test('a target refresh that fails publishes the fallback under an unknown generation', async () => {
  const state: { process: RunnerProcess; refuseDescribe?: string; refuseTarget?: string } = {
    process: { pid: 41, processStartTime: '1700000000.000001' },
    refuseDescribe: 'bridge-read-abandoned',
  };
  const { provider, sent } = bridgeRunner(state);
  const { snapshot, presented } = bridgeRoute(provider);
  await snapshot();
  state.refuseTarget = 'bridge-read-in-flight';

  const first = await snapshot();
  const second = await snapshot();

  // The app may have relaunched behind the failed refresh, so neither capture claims the old
  // generation, and the two cannot compare equal.
  expect(first.warnings).toEqual([
    'Simulator AX snapshot unavailable (target-resolution-failed); used XCTest for an unverified app generation.',
  ]);
  expect(first.comparisonIdentity?.lineage).toEqual({ targetId: `${IOS_SIMULATOR.id}:${APP}` });
  expect(second.comparisonIdentity).not.toEqual(first.comparisonIdentity);

  // The cached target survives the failed refresh, so a later refresh can still reopen the bridge.
  state.refuseTarget = undefined;
  state.refuseDescribe = undefined;
  state.process = { pid: 77, processStartTime: '1700000100.000002' };
  sent.length = 0;
  await snapshot();
  expect(presented.at(-1)!.acquisition.lineage.generation).toBe('77:1700000100.000002');
  expect(verbs(sent)).toEqual(['target', 'describe']);
});

const KNOWN_TARGET = {
  appBundleId: APP,
  targetId: `${IOS_SIMULATOR.id}:${APP}`,
  pid: 41,
  processStartTime: '1700000000.000001',
  generation: '41:1700000000.000001',
} as const;

function describeOnce(
  bridge: ReturnType<typeof createRunnerSnapshotBridge>,
  maxDurationMs = 5_000,
) {
  return bridge.source.acquire({
    target: KNOWN_TARGET,
    hint: deriveIosCaptureHint(createIosSnapshotRequest({ interactiveOnly: true })),
    limits: { maxDurationMs },
  });
}

test('a read that outlives its own budget is a timeout the route falls back from, not a cancellation', async () => {
  // Like the runner transport, the exchange turns its aborted signal into a request cancellation.
  const provider: AppleRunnerProvider = {
    hasLiveSession: () => true,
    runCommand: async (_device, _command, options) =>
      await new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(createRequestCanceledError()), {
          once: true,
        });
      }),
  };
  const bridge = createRunnerSnapshotBridge({ device: IOS_SIMULATOR, provider });

  const outcome = await describeOnce(bridge, 30);

  expect(outcome).toMatchObject({
    stage: 'failed',
    failure: { kind: 'timeout', code: 'bridge-request-deadline' },
  });
});

test('a read a cancelled capture left running costs the next capture its bridge read, not the generation', async () => {
  let finishRead!: () => void;
  const state: { process: RunnerProcess; holdNextDescribe?: Promise<void> } = {
    process: { pid: 41, processStartTime: '1700000000.000001' },
  };
  const { provider } = bridgeRunner(state);
  const { snapshot, presented, fallbacks } = bridgeRoute(provider);
  await snapshot();
  state.holdNextDescribe = new Promise((resolve) => {
    finishRead = resolve;
  });

  const cancelled = new AbortController();
  const abandoned = snapshot(cancelled.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled.abort();
  await expect(abandoned).rejects.toThrow();
  const refused = await snapshot();
  finishRead();
  await snapshot();

  expect(refused.warnings).toEqual([
    'Simulator AX snapshot unavailable (bridge-read-in-flight); used XCTest for this capture while an earlier bridge read was still running.',
  ]);
  expect(fallbacks).toHaveLength(1);
  expect(presented).toHaveLength(2);
});

function runtimeSnapshots(provider: AppleRunnerProvider) {
  const runner = createAppleRunnerRuntime({
    device: IOS_SIMULATOR,
    host: { env: {}, cwd: process.cwd() },
    provider,
  });
  const fallbacks: CaptureSnapshotInput[] = [];
  const presented: SnapshotRuntimeAcquiredResult[] = [];
  const operations = runner.bindRunnerOperations({
    signal: new AbortController().signal,
    resolveInteractor: async (_device, context) => runner.createInteractor(context),
    snapshot: {
      capture: {
        captureSnapshot: async (input) => {
          fallbacks.push(input);
          return runnerResult();
        },
        captureSnapshotWithCustomActions: async () => runnerResult(),
        captureSnapshotWithoutActiveApp: async () => runnerResult(),
      },
      present: (result) => {
        presented.push(result);
        return { ...runnerResult(), producer: result.acquisition.producer };
      },
    },
  });
  const snapshot = () => operations.captureSnapshot({ options: { appBundleId: APP } });
  return { snapshot, fallbacks, presented };
}

/** Answers the runner's system-surface host reads with `state`, and every other command as `next`. */
function withHostStates(
  provider: AppleRunnerProvider,
  state: string | undefined,
): AppleRunnerProvider {
  return {
    ...provider,
    runCommand: async (device, command, options) =>
      command.command === 'appState'
        ? state
          ? { applicationState: state }
          : {}
        : await provider.runCommand(device, command, options),
  };
}

test('the runner runtime reads a remote Simulator through the bridge once its foreground read proves no surface', async () => {
  const { provider, sent } = bridgeRunner({
    process: { pid: 41, processStartTime: '1700000000.000001' },
  });
  const { snapshot, fallbacks, presented } = runtimeSnapshots(
    withHostStates(provider, 'notRunning'),
  );

  const captured = await snapshot();

  expect(captured.warnings ?? []).toEqual([]);
  expect(fallbacks).toEqual([]);
  expect(presented.map(({ acquisition }) => acquisition.producer)).toEqual(['simulator-ax-bridge']);
  expect(verbs(sent)).toEqual(['target', 'describe']);
});

test('a runner whose foreground read cannot answer asks the bridge read to check the surface hosts', async () => {
  const { provider, sent } = bridgeRunner({
    process: { pid: 41, processStartTime: '1700000000.000001' },
  });
  const { snapshot, fallbacks } = runtimeSnapshots(withHostStates(provider, undefined));

  const captured = await snapshot();

  const describe = sent.find((command) => command.snapshotBridge?.verb === 'describe');
  expect(describe?.snapshotBridge?.surfaceHostExecutables).toEqual(
    IOS_SYSTEM_SURFACE_HOSTS.map((host) => host.processExecutable),
  );
  // The runner could not place a host process, so the capture goes to XCTest and says why.
  expect(fallbacks).toHaveLength(1);
  expect(captured.warnings).toEqual([
    'Simulator AX snapshot unavailable (system-surface-host-unverified); used XCTest for this app generation.',
  ]);
});

test('the foreground proof starts the runner when none is live, then reads only that session', async () => {
  registry.session = undefined;
  const { provider } = bridgeRunner({
    process: { pid: 41, processStartTime: '1700000000.000001' },
  });
  let started = false;
  const appStateSessions: (string | undefined)[] = [];
  const { snapshot, fallbacks } = runtimeSnapshots({
    ...provider,
    hasLiveSession: () => started,
    runCommand: async (device, command, options) => {
      if (command.command === 'uptime') {
        started = true;
        registry.session = { sessionId: 'runner-session-2', liveness: 'ready' };
        return {};
      }
      if (command.command === 'appState') {
        appStateSessions.push(options.expectedRunnerSessionId);
        return { applicationState: 'notRunning' };
      }
      return await provider.runCommand(device, command, options);
    },
  });

  await snapshot();

  expect(fallbacks).toEqual([]);
  expect(appStateSessions.length).toBeGreaterThan(0);
  expect(appStateSessions.every((id) => id === 'runner-session-2')).toBe(true);
});

test('a runner whose session id cannot be read answers the foreground proof as unknown', async () => {
  registry.session = undefined;
  const { provider, sent } = bridgeRunner({
    process: { pid: 41, processStartTime: '1700000000.000001' },
  });
  const { snapshot, fallbacks } = runtimeSnapshots(withHostStates(provider, 'notRunning'));

  await snapshot();

  expect(fallbacks).toHaveLength(1);
  expect(sent.map((command) => command.command)).not.toContain('appState');
});
