import { expect, expectTypeOf, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import type {
  BoundDeviceRuntime,
  PlatformRuntimeOperations,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import type { DaemonCommandContext } from '../context.ts';
import {
  resolveScrollRuntimePlan,
  type ScrollRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import { resolveBoundScrollRuntime } from '../scroll-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

/**
 * The retired `handleScrollCommand` suite, re-pointed at the bound runtime (R43). Every
 * assertion is the behavior `main` produced: the same parse rejections, the same execution
 * options handed to the owner, the same edge-pass loop, and the same scoped-capture failure.
 *
 * What moved is WHERE the edge refusal happens — the retired leaf discovered a missing snapshot
 * mid-command, and admission now proves the capture before any pass runs (ADR 0019 §6).
 */
type ScrollCall = { direction: string; options: unknown };

function bindings(options: {
  scroll: (direction: string, scrollOptions: unknown) => Promise<Record<string, unknown> | void>;
  captureSnapshot?: (input: { options?: { scope?: string } }) => Promise<unknown>;
}): { inspectFacts: InspectDeviceRuntimeFacts; bindDevice: BindDeviceRuntime } {
  const available = { available: true } as const;
  const facts = {
    device: { family: 'apple', kind: 'simulator', providerMode: 'local' },
    operations: {
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      scrollDirection: available,
      ...(options.captureSnapshot ? { captureSnapshot: available } : {}),
    },
  } as unknown as RuntimeFacts<PlatformRuntimeOperations>;
  return {
    inspectFacts: async () => facts,
    bindDevice: (async () =>
      ({
        facts,
        operations: {
          scrollDirection: async (input: { direction: string; options: unknown }) =>
            await options.scroll(input.direction, input.options),
          ...(options.captureSnapshot ? { captureSnapshot: options.captureSnapshot } : {}),
        },
      }) as unknown as BoundDeviceRuntime<never>) as unknown as BindDeviceRuntime,
  };
}

async function runScroll(
  positionals: string[],
  context: Partial<DaemonCommandContext>,
  options: Parameters<typeof bindings>[0],
): Promise<Record<string, unknown>> {
  const resolved = await resolveBoundScrollRuntime({
    device: IOS_SIMULATOR,
    positionals,
    context: context as DaemonCommandContext,
    ...bindings(options),
  });
  if (!resolved.ok) throw new AppError('UNSUPPORTED_OPERATION', 'admission refused the scroll');
  const data = await resolved.execute({
    dispatchContext: context as DaemonCommandContext,
  } as Parameters<typeof resolved.execute>[0]);
  return (data ?? {}) as Record<string, unknown>;
}

test('bound scroll rejects mixing amount and --pixels', async () => {
  await assert.rejects(
    () =>
      runScroll(
        ['down', '0.4'],
        { pixels: 240 },
        {
          scroll: async () => {
            throw new Error('scroll should be rejected before the owner is reached');
          },
        },
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /either a relative amount or --pixels/i.test(error.message),
  );
});

test('bound scroll forwards pixels and duration without reporting ignored duration', async () => {
  const calls: ScrollCall[] = [];
  const result = await runScroll(
    ['down'],
    { pixels: 200, durationMs: 50 },
    {
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { ok: true };
      },
    },
  );

  assert.deepEqual(calls, [
    {
      direction: 'down',
      options: {
        amount: undefined,
        pixels: 200,
        durationMs: 50,
        releaseBehavior: 'controlled',
      },
    },
  ]);
  assert.equal(result.pixels, 200);
  assert.equal(result.durationMs, undefined);
});

test('bound scroll reports duration when the owner honored it', async () => {
  const result = await runScroll(
    ['down'],
    { pixels: 200, durationMs: 50 },
    {
      scroll: async () => ({ pixels: 200, durationMs: 50 }),
    },
  );
  assert.equal(result.pixels, 200);
  assert.equal(result.durationMs, 50);
});

test('bound scroll rejects duration above the shared cap', async () => {
  await assert.rejects(
    () =>
      runScroll(
        ['down'],
        { pixels: 200, durationMs: 10_001 },
        {
          scroll: async () => {
            throw new Error('scroll should be rejected before the owner is reached');
          },
        },
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /durationMs.*at most 10000/i.test(error.message),
  );
});

test('bound scroll bottom refuses at admission when the owner declares no capture', async () => {
  const calls: ScrollCall[] = [];
  const resolved = await resolveBoundScrollRuntime({
    device: IOS_SIMULATOR,
    positionals: ['bottom'],
    context: {} as DaemonCommandContext,
    ...bindings({
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { lastPass: calls.length };
      },
    }),
  });

  assert.equal(resolved.ok, false);
  if (resolved.ok || resolved.response.ok) return;
  assert.equal(resolved.response.error.code, 'UNSUPPORTED_OPERATION');
  assert.match(String(resolved.response.error.message), /requires snapshot support/i);
  // The refusal is now proof-before-execution: no pass ran, and none could have.
  assert.equal(calls.length, 0);
});

test('bound scroll bottom does not scroll when no hidden content is below', async () => {
  const calls: ScrollCall[] = [];
  const result = await runScroll(
    ['bottom'],
    {},
    {
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { lastPass: calls.length };
      },
      captureSnapshot: async () =>
        makeScrollSnapshot({ hiddenBelow: false, message: 'Latest message' }),
    },
  );

  assert.equal(calls.length, 0);
  assert.equal(result.direction, 'down');
  assert.equal(result.edge, 'bottom');
  assert.equal(result.passes, 0);
  assert.match(String(result.message), /Already at bottom/);
});

test('bound scroll bottom scrolls only while a scoped capture confirms hidden content', async () => {
  const calls: ScrollCall[] = [];
  const snapshotScopes: unknown[] = [];
  const snapshots = [
    makeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }),
    makeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }),
    makeScrollSnapshot({ hiddenBelow: false, message: 'Latest message' }),
  ];
  const result = await runScroll(
    ['bottom'],
    {},
    {
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { lastPass: calls.length };
      },
      captureSnapshot: async (input) => {
        snapshotScopes.push(input.options?.scope);
        return snapshots[Math.min(snapshotScopes.length - 1, snapshots.length - 1)];
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    direction: 'down',
    options: {
      amount: undefined,
      pixels: undefined,
      durationMs: undefined,
      releaseBehavior: 'inertial',
    },
  });
  assert.equal(result.passes, 1);
  assert.equal(result.lastPass, 1);
  assert.deepEqual(snapshotScopes, [undefined, 'Messages', 'Messages']);
});

test('bound scroll bottom tolerates unchanged signatures while hidden content advances', async () => {
  const calls: ScrollCall[] = [];
  const snapshots = [
    makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    makeScrollSnapshot({ hiddenBelow: false, message: 'Repeated row' }),
  ];
  let snapshotIndex = 0;
  const result = await runScroll(
    ['bottom'],
    {},
    {
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { lastPass: calls.length };
      },
      captureSnapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(result.passes, 2);
});

test('bound scroll bottom keeps scoped capture failures scoped', async () => {
  let snapshotCount = 0;
  await assert.rejects(
    () =>
      runScroll(
        ['bottom'],
        {},
        {
          scroll: async () => ({}),
          captureSnapshot: async (input) => {
            snapshotCount += 1;
            if (input.options?.scope) throw new Error('scoped snapshot failed');
            return makeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' });
          },
        },
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      /scoped container/i.test(error.message) &&
      error.details?.scope === 'Messages',
  );
  assert.equal(snapshotCount, 2);
});

function makeScrollSnapshot(options: { hiddenBelow: boolean; message: string }) {
  return {
    backend: 'xctest' as const,
    nodes: [
      {
        index: 1,
        type: 'ScrollView',
        label: 'Messages',
        hiddenContentBelow: options.hiddenBelow ? true : undefined,
        rect: { x: 0, y: 100, width: 400, height: 600 },
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'Button',
        label: options.message,
        rect: { x: 0, y: 640, width: 400, height: 56 },
      },
    ],
    truncated: false,
  };
}

/**
 * R53 type-level regression. The two scroll plans must project DIFFERENT bindings: an edge scroll
 * proves `captureSnapshot` statically, and an ordinary scroll must not be able to name it at all.
 *
 * This is the property a runtime `if (!captureSnapshot) throw` guard silently gave up — the guard
 * type-checks against a widened binding, so the compiler stops enforcing what admission proved.
 */
test('the edge plan proves its capture statically and the direction plan cannot expose one', () => {
  const direction = resolveScrollRuntimePlan({});
  const edge = resolveScrollRuntimePlan({ edge: 'bottom' });

  // The discriminant carries the edge, so a caller that narrows to `edge` also holds it.
  expect(direction.kind).toBe('direction');
  expect(edge).toMatchObject({ kind: 'edge', edge: 'bottom' });

  // Structural: the required sets differ, and only the edge use names the capture.
  expect([...direction.use.required]).toEqual(['scrollDirection']);
  expect([...edge.use.required]).toEqual(['scrollDirection', 'captureSnapshot']);

  type DirectionOperations = BoundDeviceRuntime<
    Extract<ScrollRuntimePlan, { kind: 'direction' }>['use']
  >['operations'];
  type EdgeOperations = BoundDeviceRuntime<
    Extract<ScrollRuntimePlan, { kind: 'edge' }>['use']
  >['operations'];
  /** Keys the binding guarantees — an optional key drops out, which is the whole point here. */
  type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

  // The edge binding GUARANTEES the capture: demote it to `preferred` and this fails, because
  // `captureSnapshot` leaves the required set.
  expectTypeOf<RequiredKeys<EdgeOperations>>().toEqualTypeOf<
    'scrollDirection' | 'captureSnapshot'
  >();
  // The ordinary binding cannot even name a capture — absent, not merely optional.
  expectTypeOf<keyof DirectionOperations>().toEqualTypeOf<'scrollDirection'>();
  expectTypeOf<RequiredKeys<DirectionOperations>>().toEqualTypeOf<'scrollDirection'>();
});
