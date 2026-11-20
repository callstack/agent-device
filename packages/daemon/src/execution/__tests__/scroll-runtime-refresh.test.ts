import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeScrollDirectionResult } from '@agent-device/contracts/scroll-runtime';
import type { BoundDeviceRuntime, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import type { DaemonCommandContext } from '../../core/context.ts';
import type { GenericPlatformExecutionParams } from '../../core/generic-leaf-execution.ts';
import type { BindDeviceRuntime } from '../../core/request-runtime-binding.ts';
import { resolveBoundScrollRuntime } from '../scroll-runtime.ts';

const CONTAINER = { x: 0, y: 200, width: 400, height: 600 };

type Pull = { direction: string; options: unknown };

/** Resolves `scroll refresh` against an owner whose capture shows one list, and records its pulls. */
async function resolveRefresh(
  context: Partial<DaemonCommandContext>,
  owner: { hiddenAbove?: boolean; capture?: boolean } = {},
) {
  const pulls: Pull[] = [];
  const available = { available: true } as const;
  const facts = {
    device: { family: 'apple', kind: 'simulator', providerMode: 'local' },
    operations: {
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      scrollDirection: available,
      ...(owner.capture === false ? {} : { captureSnapshot: available }),
    },
  } as unknown as RuntimeFacts<PlatformRuntimeOperations>;
  const operations = {
    scrollDirection: async (input: Pull) => {
      pulls.push({ direction: input.direction, options: input.options });
      return decodeScrollDirectionResult({});
    },
    captureSnapshot: async () => ({
      backend: 'xctest' as const,
      truncated: false,
      nodes: [
        {
          index: 1,
          type: 'ScrollView',
          label: 'Feed',
          hiddenContentAbove: owner.hiddenAbove ? true : undefined,
          rect: CONTAINER,
        },
        {
          index: 2,
          parentIndex: 1,
          type: 'Button',
          label: 'First row',
          rect: { ...CONTAINER, height: 56 },
        },
      ],
    }),
  };
  const session = makeIosSession('scroll-refresh');
  const resolved = await resolveBoundScrollRuntime({
    platformServices: daemonPlatformServicesFixture(),
    device: session.device,
    positionals: ['refresh'],
    context: context as DaemonCommandContext,
    session,
    flags: undefined,
    inspectFacts: async () => facts,
    bindDevice: (async () =>
      ({
        facts,
        operations,
      }) as unknown as BoundDeviceRuntime<never>) as unknown as BindDeviceRuntime,
  });
  const execute = async (): Promise<Record<string, unknown>> => {
    assert.ok(resolved.ok);
    const params = {
      session,
      sessionName: session.name,
      command: 'scroll',
      positionals: ['refresh'],
      dispatchContext: context,
    } as unknown as GenericPlatformExecutionParams;
    return ((await resolved.execute(params)) ?? {}) as Record<string, unknown>;
  };
  return { resolved, pulls, execute };
}

test('scroll refresh is one slow pull down inside the container a fresh capture names', async () => {
  const { pulls, execute } = await resolveRefresh({});
  const result = await execute();

  assert.deepEqual(pulls, [
    {
      direction: 'up',
      options: {
        amount: 0.4,
        pixels: undefined,
        durationMs: 1200,
        releaseBehavior: 'controlled',
        containerRect: CONTAINER,
      },
    },
  ]);
  assert.equal(result.direction, 'up');
  assert.match(String(result.message), /^Pulled to refresh/);
  assert.notEqual(result.movement, 'at-edge');
});

test('scroll refresh keeps an explicit distance and duration', async () => {
  const { pulls, execute } = await resolveRefresh({ pixels: 300, durationMs: 900 });
  await execute();

  assert.partialDeepStrictEqual(pulls[0]?.options, {
    amount: undefined,
    pixels: 300,
    durationMs: 900,
  });
});

test('scroll refresh refuses, without pulling, while content is hidden above', async () => {
  const { pulls, execute } = await resolveRefresh({}, { hiddenAbove: true });

  await assert.rejects(
    execute,
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_not_at_top',
  );
  assert.equal(pulls.length, 0);
});

test('scroll refresh rejects --until before any device work', async () => {
  await assert.rejects(
    () => resolveRefresh({ until: 'label=Email' }),
    /pulls once and cannot take --until/,
  );
});

test('scroll refresh is refused at admission when the owner declares no capture', async () => {
  const { resolved } = await resolveRefresh({}, { capture: false });

  assert.equal(resolved.ok, false);
  if (resolved.ok || resolved.response.ok) return;
  assert.match(
    String(resolved.response.error.message),
    /scroll refresh.*requires snapshot support/,
  );
});
