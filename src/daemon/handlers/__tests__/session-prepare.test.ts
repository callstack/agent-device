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
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { createUnavailableRuntimeFactsForTest } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
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
  sessionStore.set(sessionName, {
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
