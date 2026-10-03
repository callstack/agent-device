import { expect, expectTypeOf, test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonRequest } from '../daemon-request.ts';
import type { SessionState } from '../session-state.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { BoundDeviceRuntime, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import {
  type PlatformRuntimeOperations,
  resolveScrollRuntimePlan,
  type ScrollRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DaemonCommandContext } from '../context.ts';
import { resolveBoundScrollRuntime } from '../scroll-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeIosSession, makeMacOsSession } from '../../__tests__/test-utils/session-factories.ts';
import { activateCompleteRefFrame, expireRefFrame } from '../ref-frame.ts';

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
  captureSnapshot?: (input: {
    options?: Record<string, unknown>;
    execution?: unknown;
  }) => Promise<unknown>;
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
  dispatch?: {
    session?: SessionState;
    flags?: CommandFlags;
  },
): Promise<Record<string, unknown>> {
  const session = dispatch?.session ?? makeIosSession('scroll-runtime');
  const request: DaemonRequest =
    dispatch?.flags === undefined
      ? { command: 'scroll', session: session.name, token: 'test-token', positionals }
      : {
          command: 'scroll',
          session: session.name,
          token: 'test-token',
          positionals,
          flags: dispatch.flags,
        };
  const resolved = await resolveBoundScrollRuntime({
    device: session.device,
    positionals,
    context: context as DaemonCommandContext,
    session,
    flags: dispatch?.flags,
    ...bindings(options),
  });
  if (!resolved.ok) throw new AppError('UNSUPPORTED_OPERATION', 'admission refused the scroll');
  // The dispatcher expires the ref frame at its side-effect seam between resolution and execution
  // (ADR 0014). Running the same transition here keeps a test honest about WHICH of the two moments
  // a scroll's own evidence has to be read at.
  expireRefFrame(session);
  const params: GenericPlatformExecutionParams = {
    session,
    sessionName: session.name,
    logPath: '/tmp/agent-device-scroll-runtime-test.log',
    command: 'scroll',
    request,
    positionals,
    out: undefined,
    dispatchContext: context as DaemonCommandContext,
  };
  const data = await resolved.execute(params);
  return (data ?? {}) as Record<string, unknown>;
}

/** A session whose stored tree IS the newest observation — what a `snapshot` leaves behind. */
function sessionWithStoredScreen(
  nodes: SnapshotNode[],
  overrides?: Partial<SessionState>,
): SessionState {
  const session = makeIosSession('scroll-runtime', {
    snapshot: buildSnapshotState({ nodes, backend: 'xctest', producer: 'apple-runner' }, undefined),
    ...overrides,
  });
  activateCompleteRefFrame(session);
  return session;
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
    session: makeIosSession('scroll-runtime'),
    positionals: ['bottom'],
    context: {} as DaemonCommandContext,
    flags: undefined,
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
        // Driven by scroll count, not capture count, so the rest-wait's own captures cannot move the
        // goalposts: content is hidden until the one pass has run, then the edge is reached.
        return makeScrollSnapshot({
          hiddenBelow: calls.length === 0,
          message: calls.length === 0 ? 'Middle message' : 'Latest message',
        });
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
  // The loop verifies against the scoped container it discovered, not the unscoped tree.
  assert.ok(snapshotScopes.includes('Messages'));
});

test('bound scroll bottom stops when the surface never shifts under hidden content', async () => {
  const calls: ScrollCall[] = [];
  await assert.rejects(
    () =>
      runScroll(
        ['bottom'],
        {},
        {
          scroll: async (direction, options) => {
            calls.push({ direction, options });
            return { lastPass: calls.length };
          },
          // Hidden content below forever, row fixed: the surface signature is byte-identical across
          // passes. A gesture that reports hidden content but moves nothing is the stuck-container
          // signature, and the loop must stop on it rather than fling to the 40-pass backstop.
          captureSnapshot: async () =>
            makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
        },
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.reason === 'scroll_edge_no_progress',
  );
  assert.equal(calls.length, 3);
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
 * proves `captureSnapshot` statically, and an ordinary scroll may hold one but can never require it.
 *
 * This is the property a runtime `if (!captureSnapshot) throw` guard silently gave up — the guard
 * type-checks against a widened binding, so the compiler stops enforcing what admission proved.
 * #2714 made the direction plan's capture a declared PREFERENCE rather than a widening: the owner
 * observes its own effect when the runtime can read the screen, and says `movement: 'unobserved'`
 * when it cannot. `RequiredKeys` is what keeps that distinction honest — a direction use that ever
 * grew a required capture stops type-checking here, and the owner would owe a refusal instead.
 */
test('the edge plan proves its capture statically and the direction plan cannot require one', () => {
  const direction = resolveScrollRuntimePlan({});
  const edge = resolveScrollRuntimePlan({ edge: 'bottom' });

  // The discriminant carries the edge, so a caller that narrows to `edge` also holds it.
  expect(direction.kind).toBe('direction');
  expect(edge).toMatchObject({ kind: 'edge', edge: 'bottom' });

  // Structural: the required sets differ, and only the edge use names the capture. The direction
  // use names it CONDITIONALLY instead — the observation that makes its answer honest is
  // correctness-bearing, which ADR 0019 §2 keeps out of `preferred`, while an owner with no capture
  // still answers the way it answered before. Both sides of that parity are pinned below.
  expect([...direction.use.required]).toEqual(['scrollDirection']);
  expect([...(direction.use.conditional ?? [])]).toEqual(['captureSnapshot']);
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
  // The ordinary binding can name a capture but never promises one: the key is present, and
  // optional, which is exactly the disclosure the `movement` field reports instead of a refusal.
  expectTypeOf<keyof DirectionOperations>().toEqualTypeOf<'scrollDirection' | 'captureSnapshot'>();
  expectTypeOf<RequiredKeys<DirectionOperations>>().toEqualTypeOf<'scrollDirection'>();
});

/** A row walked into the viewport, so the executor's pass count is observable. */
function untilNodes(targetY: number, hiddenBelow: boolean) {
  return [
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'ScrollView',
      label: 'Form',
      ...(hiddenBelow ? { hiddenContentBelow: true } : {}),
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 1,
      type: 'TextField',
      label: 'Email',
      rect: { x: 0, y: targetY, width: 400, height: 40 },
    },
  ];
}

/**
 * Route-level only: the executor's result envelope, the parse rejection, and admission. The loop's
 * own behavior — arrival, end-of-content, the pass budget, and every capture refusal — is covered
 * against the module in `scroll-until.test.ts` rather than duplicated through this harness.
 */
test('bound scroll --until reports the passes it spent and the selector it stopped on', async () => {
  const scrolls: string[] = [];
  const frames = [untilNodes(2400, true), untilNodes(1200, true), untilNodes(300, true)];
  const result = await runScroll(
    ['down'],
    { until: 'label=Email' },
    {
      captureSnapshot: async () => ({ nodes: frames[Math.min(scrolls.length, frames.length - 1)] }),
      scroll: async (direction) => {
        scrolls.push(direction);
        return { pixels: 480 };
      },
    },
  );

  assert.equal(result.until, 'label=Email');
  assert.equal(result.direction, 'down');
  assert.equal(result.passes, 2);
  assert.deepEqual(scrolls, ['down', 'down']);
  assert.match(String(result.message), /Scrolled down 2 passes until label=Email was visible/);
});

test('bound scroll rejects --until on an edge direction before any device work', async () => {
  await assert.rejects(
    () =>
      runScroll(
        ['bottom'],
        { until: 'label=Email' },
        {
          captureSnapshot: async () => ({ nodes: untilNodes(300, true) }),
          scroll: async () => {
            throw new Error('scroll should be rejected before the backend call');
          },
        },
      ),
    /cannot take --until/,
  );
});

test('bound scroll --until is refused at admission when the owner declares no capture', async () => {
  const resolved = await resolveBoundScrollRuntime({
    device: IOS_SIMULATOR,
    session: makeIosSession('scroll-runtime'),
    positionals: ['down'],
    context: { until: 'label=Email' } as DaemonCommandContext,
    flags: undefined,
    ...bindings({ scroll: async () => ({}) }),
  });
  assert.equal(resolved.ok, false);
});

/**
 * #2714: a directional scroll answers with the movement it OBSERVED, and refuses to spend a
 * distance it did not earn. The observation math lives in `scroll-movement.test.ts`; these cases
 * prove the claim reaches the command, and that it stays out of every path that was never entitled
 * to read the screen — a runtime without a capture, a Maestro replay, a `--settle` caller, the macOS
 * desktop — or that the evidence for it was never there.
 */
const SCREEN_CONTAINER = { x: 18, y: 178, width: 366, height: 662 };

function automationScreen(rowOffset: number, hiddenBelow = true): SnapshotNode[] {
  return [
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'ScrollView',
      identifier: 'lab-list',
      rect: SCREEN_CONTAINER,
      ...(hiddenBelow ? { hiddenContentBelow: true } : {}),
    },
    {
      ref: 'e2',
      index: 2,
      parentIndex: 1,
      depth: 1,
      type: 'StaticText',
      label: 'Row one',
      rect: { x: 24, y: 200 + rowOffset, width: 300, height: 20 },
    },
    {
      ref: 'e3',
      index: 3,
      parentIndex: 1,
      depth: 1,
      type: 'StaticText',
      label: 'Row two',
      rect: { x: 24, y: 260 + rowOffset, width: 300, height: 20 },
    },
  ];
}

/** The swipe the platform reports back, whose midpoint sits inside the container above. */
const OBSERVED_SWIPE = { x1: 201, y1: 600, x2: 201, y2: 250, pixels: 656, durationMs: 250 };

function frozenCaptures(frames: SnapshotNode[][]) {
  const queue = [...frames];
  let calls = 0;
  return {
    calls: () => calls,
    captureSnapshot: async () => {
      const next = queue.shift();
      if (next === undefined)
        throw new Error('scroll observed more captures than the case provided');
      calls += 1;
      return { nodes: next, backend: 'xctest', producer: 'apple-runner' };
    },
  };
}

/**
 * The scroll of a session that just captured this screen and has moved nothing since: the one
 * situation in which the stored tree really is the pre-gesture surface.
 */
function scrollOverStoredScreen(options: {
  frames: SnapshotNode[][];
  baseline?: SnapshotNode[];
  flags?: CommandFlags;
  session?: SessionState;
  positionals?: string[];
}) {
  const captures = frozenCaptures(options.frames);
  const scroll = runScroll(
    options.positionals ?? ['down', '0.75'],
    {},
    { ...captures, scroll: async () => ({ ...OBSERVED_SWIPE }) },
    {
      session: options.session ?? sessionWithStoredScreen(options.baseline ?? automationScreen(0)),
      ...(options.flags === undefined ? {} : { flags: options.flags }),
    },
  );
  return { scroll, captures };
}

test('bound scroll refuses the distance when the screen it read never moved', async () => {
  const { scroll } = scrollOverStoredScreen({ frames: [automationScreen(0), automationScreen(0)] });

  await assert.rejects(
    () => scroll,
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'scroll_no_progress' &&
      error.details.direction === 'down' &&
      error.details.hiddenContentAt === 'bottom',
  );
});

test('bound scroll keeps its distance and says the surface moved when it did', async () => {
  const { scroll, captures } = scrollOverStoredScreen({
    frames: [automationScreen(-320)],
  });
  const result = await scroll;

  assert.equal(result.movement, 'moved');
  assert.match(String(result.message), /Scrolled down by 0\.75 of the viewport \(656px\)/);
  assert.equal(captures.calls(), 1);
});

test('bound scroll stops claiming a movement its runtime cannot read', async () => {
  const captures = frozenCaptures([automationScreen(0), automationScreen(0)]);
  const result = await runScroll(
    ['down', '0.75'],
    {},
    // The same case WITHOUT the capture: this runtime cannot read a screen, so the answer carries
    // no movement claim at all rather than one it could not have made.
    { scroll: async () => ({ ...OBSERVED_SWIPE }) },
    { session: sessionWithStoredScreen(automationScreen(0)) },
  );

  assert.equal('movement' in result, false);
  assert.equal(captures.calls(), 0);
});

test('bound scroll reads no screen for a Maestro replay that asked for no stabilization', async () => {
  const { scroll, captures } = scrollOverStoredScreen({
    frames: [automationScreen(0), automationScreen(0)],
    flags: { postGestureStabilization: false },
  });
  const result = await scroll;

  assert.equal('movement' in result, false);
  assert.equal(captures.calls(), 0);
});

test('bound scroll spends no capture on a movement another observer already owns', async () => {
  const { scroll, captures } = scrollOverStoredScreen({
    frames: [automationScreen(0), automationScreen(0)],
    flags: { settle: true },
  });
  const result = await scroll;

  assert.equal('movement' in result, false);
  assert.equal(captures.calls(), 0);
});

test('bound scroll on the macOS desktop reads no screen to confirm a scroll', async () => {
  const captures = frozenCaptures([automationScreen(0), automationScreen(0)]);
  const session = makeMacOsSession('scroll-desktop');
  session.snapshot = buildSnapshotState(
    { nodes: automationScreen(0), backend: 'xctest', producer: 'apple-runner' },
    undefined,
  );
  activateCompleteRefFrame(session);

  const result = await runScroll(
    ['down', '0.75'],
    {},
    { ...captures, scroll: async () => ({ ...OBSERVED_SWIPE }) },
    { session },
  );

  assert.equal('movement' in result, false);
  assert.equal(captures.calls(), 0);
});

/**
 * The pair to the refusal above, and the reason the refusal is allowed to exist: a tree that
 * predates a device side effect says nothing about what THIS gesture did. The session's ref frame
 * is the existing owner of that answer (ADR 0014), so a scroll after a mutation says it observed
 * nothing rather than crediting the swipe with whatever the earlier command changed.
 */
test('bound scroll will not read movement off a tree that predates the last mutation', async () => {
  const captures = frozenCaptures([automationScreen(-320)]);
  const session = sessionWithStoredScreen(automationScreen(0));
  // Whatever the previous command was, it crossed the side-effect seam before this scroll resolved.
  expireRefFrame(session);

  const result = await runScroll(
    ['down', '0.75'],
    {},
    { ...captures, scroll: async () => ({ ...OBSERVED_SWIPE }) },
    { session },
  );

  assert.equal(result.movement, 'unobserved');
  assert.equal(captures.calls(), 0);
});

test('bound scroll will not bill an unread earlier gesture to the scroll it is dispatching', async () => {
  const captures = frozenCaptures([automationScreen(-320)]);
  const session = sessionWithStoredScreen(automationScreen(0), {
    postGestureStabilization: { action: 'press', positionals: [], markedAt: Date.now() },
  });

  const result = await runScroll(
    ['down', '0.75'],
    {},
    { ...captures, scroll: async () => ({ ...OBSERVED_SWIPE }) },
    { session },
  );

  assert.equal(result.movement, 'unobserved');
  assert.equal(captures.calls(), 0);
});
