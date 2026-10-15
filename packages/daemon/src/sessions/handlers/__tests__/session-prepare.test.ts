import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  MACOS_DEVICE,
} from '@agent-device/test-kit/device-fixtures';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit/runtime-operation-facts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../core/request-runtime-binding.ts';
import { handlePrepareCommand } from '../session-prepare.ts';

// `resolveCommandDevice` widens to `resolveTargetDevice` for an explicit selector (this test
// always supplies `--udid`), which otherwise reaches the real device-selection dispatcher.
vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return { ...actual, resolveTargetDevice: vi.fn(async () => IOS_SIMULATOR) };
});

// Matches REQUEST_TIMEOUT_BUDGET_MARGIN_MS, packages/command-registry/src/timeout-policy.ts. Not
// imported: it is not exported (fallow would flag an export used only by a test).
const REQUIRED_DAEMON_RESULT_MARGIN_MS = 30_000;

function prepareRuntimeFacts(): RuntimeFacts<PlatformRuntimeOperations> {
  const unavailableFacts = createUnavailableRuntimeFactsForTest(
    IOS_SIMULATOR,
    localRuntimeOwner('apple'),
  );
  return {
    ...unavailableFacts,
    operations: { ...unavailableFacts.operations, prepareAppleRunner: { available: true } },
  };
}

/**
 * Runs `prepare ios-runner` through the production handler with a fake runner binding that
 * records the `timeoutMs` it was handed, then checks that value (plus the daemon-result margin)
 * against the same request's resolved client envelope — the rule 1d proves, not just the
 * constants it happens to compile to.
 */
async function runPrepare(flags: { timeoutMs?: number }): Promise<{
  handlerTimeoutMs: number;
  envelopeMs: number | undefined;
}> {
  const sessionName = 'prepare-envelope-margin';
  const sessionStore = makeSessionStore('agent-device-prepare-handler-');
  sessionStore.publish(sessionName, {
    name: sessionName,
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  });

  let handlerTimeoutMs: number | undefined;
  const inspectFacts: InspectDeviceRuntimeFacts = async () => prepareRuntimeFacts();
  const bindDevice: BindDeviceRuntime = async (device, use) =>
    narrowDeviceBinding(
      {
        device,
        owner: localRuntimeOwner('apple'),
        facts: prepareRuntimeFacts(),
        operations: {
          prepareAppleRunner: async (input: { timeoutMs: number }) => {
            handlerTimeoutMs = input.timeoutMs;
            return { runner: {}, connectMs: 1, healthCheckMs: 1 };
          },
        },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );

  const positionals = ['ios-runner'];
  const requestFlags: CommandFlags = {
    udid: IOS_SIMULATOR.id,
    platform: 'ios',
    ...flags,
  };
  const response = await handlePrepareCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'prepare',
      positionals,
      flags: requestFlags,
    },
    sessionName,
    logPath: '/dev/null',
    sessionStore,
    inspectFacts,
    bindDevice,
  });

  expect(response?.ok, JSON.stringify(response)).toBe(true);
  expect(handlerTimeoutMs).toBeDefined();

  const envelopeMs = resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('prepare'), {
    positionals,
    flags: requestFlags,
  });
  return { handlerTimeoutMs: handlerTimeoutMs!, envelopeMs };
}

type PrepareRunnerResult = Awaited<
  ReturnType<NonNullable<PlatformRuntimeOperations['prepareAppleRunner']>>
>;

/**
 * Runs `prepare ios-runner` against `device` with no session, answering `prepareAppleRunner`
 * through the injected binding. Facts admit the operation only for Apple devices, as the
 * platform owners publish it.
 */
async function invokePrepare(params: {
  device: DeviceInfo;
  flags?: CommandFlags;
  positionals?: string[];
  prepareAppleRunner?: (input: {
    timeoutMs: number;
    execution: { requestId?: string; logPath?: string };
  }) => Promise<PrepareRunnerResult>;
}) {
  const { device } = params;
  const sessionStore = makeSessionStore('agent-device-prepare-handler-');
  const unavailableFacts = createUnavailableRuntimeFactsForTest(device, localRuntimeOwner('apple'));
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    ...unavailableFacts,
    operations: {
      ...unavailableFacts.operations,
      ...(device.platform === 'apple' ? { prepareAppleRunner: { available: true } } : {}),
    },
  };
  const prepareAppleRunner = vi.fn(
    params.prepareAppleRunner ??
      (async () => ({ runner: { currentUptimeMs: 42 }, connectMs: 3, healthCheckMs: 3 })),
  );
  const inspectFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn();
  const bindDeviceRuntime: BindDeviceRuntime = async (candidate, use) => {
    bindDevice();
    return narrowDeviceBinding(
      {
        device: candidate,
        owner: localRuntimeOwner('apple'),
        facts,
        operations: { prepareAppleRunner },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );
  };
  vi.mocked(resolveTargetDevice).mockClear();
  vi.mocked(resolveTargetDevice).mockResolvedValue(device);
  const response = await handlePrepareCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'prepare-session',
      command: 'prepare',
      positionals: params.positionals ?? ['ios-runner'],
      flags: params.flags ?? { udid: device.id },
      meta: { requestId: 'prepare-request' },
    },
    sessionName: 'prepare-session',
    logPath: '/dev/null',
    sessionStore,
    inspectFacts,
    bindDevice: bindDeviceRuntime,
  });
  return { response, sessionStore, prepareAppleRunner, inspectFacts, bindDevice };
}

test.each([
  { device: IOS_SIMULATOR, platform: 'ios' },
  { device: MACOS_DEVICE, platform: 'macos' },
])(
  'prepare ios-runner on $device.name hands the runner the requested budget and reports the device',
  async ({ device, platform }) => {
    const { response, sessionStore, prepareAppleRunner, inspectFacts, bindDevice } =
      await invokePrepare({ device, flags: { udid: device.id, timeoutMs: 240_000 } });

    expect(response.ok).toBe(true);
    expect(inspectFacts).toHaveBeenCalledTimes(1);
    expect(bindDevice).toHaveBeenCalledTimes(1);
    expect(prepareAppleRunner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        timeoutMs: 240_000,
        execution: expect.objectContaining({
          requestId: 'prepare-request',
          logPath: '/dev/null',
        }),
      }),
    );
    if (response.ok) {
      expect(response.data).toMatchObject({
        action: 'ios-runner',
        platform,
        deviceId: device.id,
        deviceName: device.name,
        kind: device.kind,
        connectMs: 3,
        healthCheckMs: 3,
        runner: { currentUptimeMs: 42 },
        message: `Prepared Apple runner: ${device.name}`,
      });
    }
    expect(sessionStore.get('prepare-session')).toBeUndefined();
  },
);

test('prepare ios-runner explains overlapping timing fields with additive parts', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000));
  try {
    const { response } = await invokePrepare({
      device: IOS_SIMULATOR,
      prepareAppleRunner: async () => {
        vi.setSystemTime(new Date(28_337));
        return {
          runner: { currentUptimeMs: 42 },
          buildMs: 10_642,
          connectMs: 12_635,
          healthCheckMs: 14_702,
        };
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const data = response.data as Record<string, any>;
    expect(data).toMatchObject({
      buildMs: 10_642,
      connectMs: 12_635,
      healthCheckMs: 14_702,
      timing: {
        totalMs: expect.any(Number),
        additiveParts: {
          buildMs: 10_642,
          connectAfterBuildMs: 1_993,
          healthCheckMs: 14_702,
        },
        containment: {
          connectMs: ['buildMs'],
          healthCheckMs: [],
        },
      },
    });
    expect(data.durationMs).toBe(27_337);
    expect(data.timing.totalMs).toBe(data.durationMs);
    expect(String(data.timing.note)).toMatch(/top-level prepare timing fields.*may overlap/i);
    const additiveParts = data.timing.additiveParts as Record<string, number>;
    const additiveTotalMs = Object.values(additiveParts).reduce((sum, value) => sum + value, 0);
    expect(additiveTotalMs).toBeLessThanOrEqual(data.timing.totalMs);
    expect(data.buildMs + data.connectMs + data.healthCheckMs).toBeGreaterThan(data.durationMs);
  } finally {
    vi.useRealTimers();
  }
});

test('prepare ios-runner rejects a device whose owner publishes no runner preparation', async () => {
  const { response, inspectFacts, bindDevice, prepareAppleRunner } = await invokePrepare({
    device: ANDROID_EMULATOR,
    flags: { platform: 'android', serial: ANDROID_EMULATOR.id },
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toBe('prepare is not supported on this device');
  }
  expect(inspectFacts).toHaveBeenCalledTimes(1);
  expect(bindDevice).not.toHaveBeenCalled();
  expect(prepareAppleRunner).not.toHaveBeenCalled();
});

test('prepare requires the ios-runner subcommand', async () => {
  const { response, bindDevice } = await invokePrepare({
    device: IOS_SIMULATOR,
    positionals: [],
    flags: { platform: 'ios' },
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('prepare requires a subcommand: ios-runner');
  }
  expect(resolveTargetDevice).not.toHaveBeenCalled();
  expect(bindDevice).not.toHaveBeenCalled();
});

test('prepare ios-runner with no --timeout keeps the daemon-result margin under the envelope', async () => {
  const { handlerTimeoutMs, envelopeMs } = await runPrepare({});
  expect(envelopeMs).toBeDefined();
  expect(handlerTimeoutMs + REQUIRED_DAEMON_RESULT_MARGIN_MS).toBeLessThanOrEqual(envelopeMs!);
});

test('prepare ios-runner --timeout 300000 keeps the daemon-result margin under the envelope', async () => {
  const { handlerTimeoutMs, envelopeMs } = await runPrepare({ timeoutMs: 300_000 });
  expect(envelopeMs).toBeDefined();
  expect(handlerTimeoutMs).toBe(300_000);
  expect(handlerTimeoutMs + REQUIRED_DAEMON_RESULT_MARGIN_MS).toBeLessThanOrEqual(envelopeMs!);
});

test('prepare ios-runner --timeout 60000 keeps the daemon-result margin under the envelope', async () => {
  const { handlerTimeoutMs, envelopeMs } = await runPrepare({ timeoutMs: 60_000 });
  expect(envelopeMs).toBeDefined();
  expect(handlerTimeoutMs).toBe(60_000);
  expect(handlerTimeoutMs + REQUIRED_DAEMON_RESULT_MARGIN_MS).toBeLessThanOrEqual(envelopeMs!);
});
