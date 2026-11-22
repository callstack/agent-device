import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  type DeviceBinding,
  type DeviceBindingRequest,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeModule,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import {
  createOwnerScopedDeviceClaimReconciler,
  inspectDeviceClaimRecovery,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import {
  releaseProvenStaleDeviceClaims,
  type DeviceClaimStaleReleaseOutcome,
} from '@agent-device/daemon-contracts/device-claims';
import {
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createComposedPlatformRuntimeGateway } from '../platform-runtime-gateway.ts';
import { runStaleDeviceClaimRelease } from '../platform-runtime-claim-recovery.ts';

const ACQUISITION_DEADLINE_MS = 5_000;
const DISPOSAL_BUDGET_MS = 5_000;
const DEVICE_KEY = 'local:android:none:emulator-5554';
const OWNER = localRuntimeOwner('android');

afterEach(() => {
  vi.useRealTimers();
});

function staleClaimWithOpenAppLog() {
  const stateDir = mkdtempForTestSync('claim-recovery-disposal-state-');
  const claimsDir = mkdtempForTestSync('claim-recovery-disposal-claims-');
  const env = { AGENT_DEVICE_CLAIMS_DIR: claimsDir };
  const device = { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' };
  const session = 'dead-session';
  appLogResourceStore.write(
    appLogResourceStore.resolvePath(path.join(stateDir, 'sessions', session)),
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: session,
      device: { id: device.id, family: 'android', kind: 'emulator' },
      owner: OWNER,
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  const claimPath = path.join(claimsDir, `${hashDeviceKey(DEVICE_KEY)}.json`);
  fs.writeFileSync(
    claimPath,
    JSON.stringify({
      schemaVersion: 3,
      claimOwnerKind: 'open-session',
      deviceKey: DEVICE_KEY,
      device,
      session,
      workspace: '/worktrees/dead',
      stateDir,
      ownerPid: 999_999_999,
      ownerStartTime: 'dead-start',
      ownerToken: 'claim-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  return { env, claimPath, claimBytes: fs.readFileSync(claimPath, 'utf8') };
}

function hashDeviceKey(deviceKey: string): string {
  return crypto.createHash('sha256').update(deviceKey).digest('hex');
}

function androidOwner(shutdown: () => Promise<void>) {
  const bind = vi.fn(
    async (request: DeviceBindingRequest): Promise<DeviceBinding<PlatformRuntimeOperations>> => {
      const unavailableFacts = createUnavailableRuntimeFactsForTest(request.device, OWNER);
      return {
        device: request.device,
        owner: OWNER,
        facts: {
          ...unavailableFacts,
          operations: {
            ...unavailableFacts.operations,
            appLogReattach: { available: true },
            appLogCleanup: { available: true },
          },
        },
        operations: {
          appLogReattach: async () => ({ status: 'missing' }),
          appLogCleanup: async () => ({ status: 'cleaned' }),
        },
        [Symbol.asyncDispose]: async () => {},
      } as DeviceBinding<PlatformRuntimeOperations>;
    },
  );
  const owner = {
    owner: OWNER,
    ownsDevice: () => true,
    inspectFacts: async () => {
      throw new Error('stale-claim recovery binds; it never inspects facts');
    },
    bind,
    shutdown: vi.fn(shutdown),
  } as unknown as PlatformRuntimeOwner;
  return { owner, bind, shutdown: owner.shutdown };
}

function composedRecovery(loadRuntime: () => Promise<PlatformRuntimeOwner>, signal: AbortSignal) {
  const emit = vi.fn();
  const androidModule = {
    family: 'android',
    loadRuntime,
  } as unknown as PlatformRuntimeModule;
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope: { signal, diagnostics: { emit }, progress: { report: () => {} } },
    beforeGateway: inspectDeviceClaimRecovery,
    composeGateway: () =>
      createComposedPlatformRuntimeGateway({
        modules: new Map([['android', androidModule]]),
        loadHost: async () => ({}) as PlatformRuntimeHost,
      }),
  });
  return { reconcile, emit };
}

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

test.each(['deadline', 'cancellation'] as const)(
  'a never-settling owner load after acquisition %s retains the claim within the disposal budget',
  async (interruption) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = staleClaimWithOpenAppLog();
    const lateShutdownFailure = new AppError('COMMAND_FAILED', 'android owner refused to close', {
      reason: 'android-owner-close-refused',
    });
    const late = androidOwner(async () => {
      throw lateShutdownFailure;
    });
    let enterLoad!: () => void;
    const loadEntered = new Promise<void>((resolve) => {
      enterLoad = resolve;
    });
    let finishLoad!: () => void;
    const loadReleased = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const loadRuntime = vi.fn(async () => {
      enterLoad();
      await loadReleased;
      return late.owner;
    });
    const cancellation = new AbortController();
    const { reconcile, emit } = composedRecovery(loadRuntime, cancellation.signal);

    const release = track(releaseProvenStaleDeviceClaims({ selectors: {}, reconcile, env: f.env }));
    await loadEntered;
    if (interruption === 'cancellation') cancellation.abort(new Error('caller canceled'));
    else await vi.advanceTimersByTimeAsync(ACQUISITION_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(DISPOSAL_BUDGET_MS - 1);
    expect(release.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(release.settled).toBe(true);
    expect(release.value).toEqual([
      expect.objectContaining<Partial<DeviceClaimStaleReleaseOutcome>>({
        deviceKey: DEVICE_KEY,
        status: 'retained',
        reason: 'app-log-cleanup-pending',
      }),
    ]);
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(emit).toHaveBeenCalledWith({
      level: 'warn',
      phase: 'device_claim_recovery_dispose_pending',
      data: {
        deviceKey: DEVICE_KEY,
        ownerSession: 'dead-session',
        budgetMs: DISPOSAL_BUDGET_MS,
        retainedReason: 'app-log-cleanup-pending',
      },
    });
    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'device_claim_recovery_dispose_failed' }),
    );

    finishLoad();
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          phase: 'device_claim_recovery_dispose_failed',
          data: expect.objectContaining({
            deviceKey: DEVICE_KEY,
            afterBudget: true,
            retainedReason: 'app-log-cleanup-pending',
            error: expect.objectContaining({
              details: expect.objectContaining({ reason: 'platform-owner-shutdown-failed' }),
            }),
          }),
        }),
      ),
    );
    expect(late.shutdown).toHaveBeenCalledOnce();
    expect(late.bind).not.toHaveBeenCalled();
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(release.value?.[0]).toMatchObject({
      status: 'retained',
      reason: 'app-log-cleanup-pending',
    });
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
  },
);

test('a loaded owner closes inside the disposal budget and the stale claim clears', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const f = staleClaimWithOpenAppLog();
  const ready = androidOwner(async () => {});
  const { reconcile, emit } = composedRecovery(
    async () => ready.owner,
    new AbortController().signal,
  );

  await expect(
    releaseProvenStaleDeviceClaims({ selectors: {}, reconcile, env: f.env }),
  ).resolves.toEqual([expect.objectContaining({ deviceKey: DEVICE_KEY, status: 'released' })]);

  expect(vi.getTimerCount()).toBe(0);
  expect(ready.bind).toHaveBeenCalledOnce();
  expect(ready.shutdown).toHaveBeenCalledOnce();
  expect(fs.existsSync(f.claimPath)).toBe(false);
  expect(emit).not.toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'device_claim_recovery_dispose_pending' }),
  );
});

test('runStaleDeviceClaimRelease writes outcomes at the bound and waits for late owner shutdown and diagnostics before returning', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const f = staleClaimWithOpenAppLog();
  const logPath = path.join(mkdtempForTestSync('claim-recovery-cli-log-'), 'cli.ndjson');
  let enterDispose!: () => void;
  const disposeEntered = new Promise<void>((resolve) => {
    enterDispose = resolve;
  });
  let finishDispose!: () => void;
  const disposeReleased = new Promise<void>((resolve) => {
    finishDispose = resolve;
  });
  const shutdown = vi.fn(async () => {
    enterDispose();
    await disposeReleased;
    throw new AppError('COMMAND_FAILED', 'late CLI owner shutdown failed', {
      reason: 'platform-owner-shutdown-failed',
    });
  });
  const events: string[] = [];
  const writtenOutcomes: DeviceClaimStaleReleaseOutcome[][] = [];

  const release = track(
    withDiagnosticsScope(
      { session: 'cli', requestId: 'req-cli-stale', command: 'device', debug: false, logPath },
      async () =>
        await runStaleDeviceClaimRelease(
          {},
          createTestHostEnvironment({ env: f.env }),
          () => ({
            reconcile: async () => ({ status: 'retained', reason: 'app-log-cleanup-pending' }),
            dispose: async () => {
              try {
                await shutdown();
              } finally {
                events.push('late-shutdown-finished');
              }
            },
          }),
          {
            afterOutcomes: (outcomes) => {
              events.push('output-written');
              writtenOutcomes.push(outcomes);
            },
          },
        ),
    ),
  );

  await disposeEntered;
  await vi.advanceTimersByTimeAsync(DISPOSAL_BUDGET_MS);
  await vi.waitFor(() => expect(events).toEqual(['output-written']));
  expect(writtenOutcomes).toEqual([
    [
      expect.objectContaining<Partial<DeviceClaimStaleReleaseOutcome>>({
        deviceKey: DEVICE_KEY,
        status: 'retained',
        reason: 'app-log-cleanup-pending',
      }),
    ],
  ]);
  expect(release.settled).toBe(false);
  expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);

  finishDispose();
  await vi.waitFor(() => expect(release.settled).toBe(true));
  expect(shutdown).toHaveBeenCalledOnce();
  expect(events).toEqual(['output-written', 'late-shutdown-finished']);
  expect(release.value).toEqual(writtenOutcomes[0]);
  const entries = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> });
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: 'device_claim_recovery_dispose_failed',
        data: expect.objectContaining({
          afterBudget: true,
          retainedReason: 'app-log-cleanup-pending',
        }),
      }),
    ]),
  );
});

const execFileAsync = promisify(execFile);

test('runStaleDeviceClaimRelease keeps a Node subprocess alive until an unref-backed late disposal finishes', async () => {
  const f = staleClaimWithOpenAppLog();
  const recoveryModuleUrl = pathToFileURL(
    path.resolve(import.meta.dirname, '../platform-runtime-claim-recovery.ts'),
  ).href;
  const script = `
    import { runStaleDeviceClaimRelease } from ${JSON.stringify(recoveryModuleUrl)};
    await runStaleDeviceClaimRelease(
      {},
      { env: process.env, cwd: process.cwd() },
      () => ({
        reconcile: async () => ({ status: 'retained', reason: 'app-log-cleanup-pending' }),
        dispose: async () => {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 150);
            timer.unref();
          });
          process.stdout.write('LATE_SHUTDOWN_FINISHED\\n');
        },
      }),
      {
        disposeBudgetMs: 25,
        afterOutcomes: (outcomes) => {
          process.stdout.write('OUTPUT_WRITTEN:' + outcomes[0]?.status + ':' + outcomes[0]?.reason + '\\n');
        },
      },
    );
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, ...f.env },
      timeout: 10_000,
    },
  );
  const lines = stdout.trim().split('\n');
  expect(lines).toEqual([
    'OUTPUT_WRITTEN:retained:app-log-cleanup-pending',
    'LATE_SHUTDOWN_FINISHED',
  ]);
  expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
});
