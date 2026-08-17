import {
  COORDINATE_GESTURE_KINDS,
  SCROLL_DIRECTIONS,
  SWIPE_PRESETS,
  type GesturePayload,
} from '@agent-device/contracts/interaction';
import {
  attachRefs,
  type Point,
  type RawSnapshotNode,
  type Rect,
  type SnapshotNode,
} from '@agent-device/kernel/snapshot';
import fc from 'fast-check';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';

/**
 * Shared fast-check generators for the pure parse/print and geometry kernels
 * (#1413). Each property lives in its owning module's test file; the inputs
 * live here so the hazard vocabulary (quote/apostrophe/escape shapes, compact
 * viewports, pinned refs) is written once and every property inherits the next
 * hazard someone adds.
 *
 * fast-check reports the SHRUNK counterexample plus the seed/path to replay it,
 * so a failure names a minimal input rather than the raw random one.
 */

/**
 * Run budget for every property in the unit suite. Properties share the unit
 * slow-test budget (2.5s per file, see docs/agents/testing.md), so the count is
 * bounded here rather than per call site — raise it in one place, and only with
 * a measured file duration.
 */
export const PROPERTY_RUNS = 100;

/** Cheaper budget for properties whose single run does real work (diff, planning). */
export const PROPERTY_RUNS_SMALL = 40;

// ---------------------------------------------------------------------------
// Refs (`@eN~sM`)
// ---------------------------------------------------------------------------

export type GeneratedRef = { base: string; generation?: number };

export const refArb: fc.Arbitrary<GeneratedRef> = fc
  .record({
    at: fc.boolean(),
    index: fc.nat({ max: 999 }),
    generation: fc.option(fc.nat({ max: 999 }), { nil: undefined }),
  })
  .map(({ at, index, generation }) => ({
    base: `${at ? '@' : ''}e${index}`,
    ...(generation === undefined ? {} : { generation }),
  }));

/** The `@eN~sM` spelling of a split ref; the inverse of `splitRefGenerationSuffix`. */
export function formatRef(ref: GeneratedRef): string {
  return ref.generation === undefined ? ref.base : `${ref.base}~s${ref.generation}`;
}

// ---------------------------------------------------------------------------
// Rects / viewports
// ---------------------------------------------------------------------------

/** Smallest supported iPhone viewports — the geometry examples worth keeping. */
export const COMPACT_VIEWPORTS: readonly Rect[] = [
  { x: 0, y: 0, width: 320, height: 568 },
  { x: 0, y: 0, width: 375, height: 667 },
];

const viewportRectArb: fc.Arbitrary<Rect> = fc.oneof(
  fc.constantFrom(...COMPACT_VIEWPORTS),
  fc.record({
    x: fc.integer({ min: 0, max: 200 }),
    y: fc.integer({ min: 0, max: 200 }),
    width: fc.integer({ min: 1, max: 2400 }),
    height: fc.integer({ min: 1, max: 2400 }),
  }),
);

export const scrollingContainerTypeArb = fc.constantFrom(
  'XCUIElementTypeScrollView',
  'XCUIElementTypeTable',
  'XCUIElementTypeCollectionView',
  'android.widget.ListView',
  'androidx.recyclerview.widget.RecyclerView',
);

export const distinctRectPairArb: fc.Arbitrary<{ ancestor: Rect; target: Rect }> = fc
  .record({
    x: fc.integer({ min: -200, max: 200 }),
    y: fc.integer({ min: -200, max: 200 }),
    width: fc.integer({ min: 1, max: 1200 }),
    height: fc.integer({ min: 1, max: 1200 }),
  })
  .chain((ancestor) =>
    fc.constantFrom<keyof Rect>('x', 'y', 'width', 'height').map((field) => ({
      ancestor,
      target: { ...ancestor, [field]: ancestor[field] + 1 },
    })),
  );

export type InteractionTouchPointScenario = {
  nodes: SnapshotNode[];
  permutedNodes: SnapshotNode[];
  target: SnapshotNode;
  bound: Rect;
  competitorRects: Rect[];
};

const halfPixel = (value: number): number => value / 2;
const touchPointAxisStepsArb = fc.oneof(
  fc.integer({ min: 4, max: 46 }),
  fc.integer({ min: 48, max: 800 }),
);

const touchPointTargetRectArb = fc
  .record({
    x: fc.integer({ min: -200, max: 200 }),
    y: fc.integer({ min: -200, max: 200 }),
    // Exercise dense desktop rows as well as standard mobile touch targets.
    width: touchPointAxisStepsArb,
    height: touchPointAxisStepsArb,
  })
  .map(({ x, y, width, height }) => ({
    x: halfPixel(x),
    y: halfPixel(y),
    width: halfPixel(width),
    height: halfPixel(height),
  }));

function containedRectArb(container: Rect): fc.Arbitrary<Rect> {
  const widthSteps = Math.round(container.width * 2);
  const heightSteps = Math.round(container.height * 2);
  return fc
    .record({
      width: fc.integer({ min: 2, max: widthSteps - 2 }),
      height: fc.integer({ min: 2, max: heightSteps - 2 }),
    })
    .chain(({ width, height }) =>
      fc
        .record({
          x: fc.integer({ min: 0, max: widthSteps - width }),
          y: fc.integer({ min: 0, max: heightSteps - height }),
        })
        .map(({ x, y }) => ({
          x: container.x + halfPixel(x),
          y: container.y + halfPixel(y),
          width: halfPixel(width),
          height: halfPixel(height),
        })),
    );
}

export const interactionTouchPointScenarioArb: fc.Arbitrary<InteractionTouchPointScenario> =
  touchPointTargetRectArb.chain((targetRect) =>
    fc
      .tuple(
        fc.array(containedRectArb(targetRect), { minLength: 1, maxLength: 6 }),
        containedRectArb(targetRect),
      )
      .chain(([competitorRects, bound]) => {
        const nodes = attachRefs([
          {
            index: 0,
            depth: 0,
            type: 'Link',
            label: 'Generated parent',
            rect: targetRect,
            hittable: true,
          },
          ...competitorRects.map((rect, offset) => ({
            index: offset + 1,
            depth: 1,
            parentIndex: 0,
            type: 'Button',
            label: `Generated child ${offset + 1}`,
            rect,
            hittable: true,
          })),
        ]);
        return fc
          .shuffledSubarray(nodes, { minLength: nodes.length, maxLength: nodes.length })
          .map((permutedNodes) => ({
            nodes,
            permutedNodes,
            target: nodes[0]!,
            bound,
            competitorRects,
          }));
      }),
  );

/** A point sampled from the viewport's own box, so most gestures are plannable. */
function pointInViewportArb(viewport: Rect): fc.Arbitrary<Point> {
  return fc.record({
    x: fc.integer({ min: Math.floor(viewport.x), max: Math.floor(viewport.x + viewport.width) }),
    y: fc.integer({ min: Math.floor(viewport.y), max: Math.floor(viewport.y + viewport.height) }),
  });
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/**
 * One payload arbitrary per canonical gesture kind. Keyed by `GESTURE_KINDS`,
 * so a new kind fails to typecheck here instead of silently escaping the
 * geometry property.
 */
function gesturePayloadArbByKind(
  viewport: Rect,
): Record<(typeof COORDINATE_GESTURE_KINDS)[number], fc.Arbitrary<GesturePayload>> {
  const origin = pointInViewportArb(viewport);
  const delta = fc.record({
    x: fc.integer({ min: -viewport.width, max: viewport.width }),
    y: fc.integer({ min: -viewport.height, max: viewport.height }),
  });
  const durationMs = fc.option(fc.integer({ min: 16, max: 2000 }), { nil: undefined });
  const scale = fc.double({ min: 0.1, max: 4, noNaN: true, noDefaultInfinity: true });
  return {
    pan: fc.record({
      kind: fc.constant('pan' as const),
      origin,
      delta,
      pointerCount: fc.constantFrom(undefined, 1 as const, 2 as const),
      durationMs,
    }),
    fling: fc.record({
      kind: fc.constant('fling' as const),
      direction: fc.constantFrom(...SCROLL_DIRECTIONS),
      origin,
      distance: fc.option(fc.integer({ min: 1, max: 1200 }), { nil: undefined }),
    }),
    swipe: fc.record({
      kind: fc.constant('swipe' as const),
      preset: fc.constantFrom(...SWIPE_PRESETS),
    }),
    pinch: fc.record({
      kind: fc.constant('pinch' as const),
      scale,
      origin: fc.option(origin, { nil: undefined }),
    }),
    rotate: fc.record({
      kind: fc.constant('rotate' as const),
      degrees: fc.integer({ min: -720, max: 720 }),
      origin: fc.option(origin, { nil: undefined }),
    }),
    transform: fc.record({
      kind: fc.constant('transform' as const),
      origin,
      delta,
      scale,
      degrees: fc.integer({ min: -720, max: 720 }),
      durationMs,
    }),
  };
}

/** A viewport with a gesture payload of every supported kind planned against it. */
export const gestureInViewportArb: fc.Arbitrary<{ viewport: Rect; gesture: GesturePayload }> =
  viewportRectArb.chain((viewport) => {
    const byKind = gesturePayloadArbByKind(viewport);
    return fc.record({
      viewport: fc.constant(viewport),
      gesture: fc.oneof(...COORDINATE_GESTURE_KINDS.map((kind) => byKind[kind])),
    });
  });

// ---------------------------------------------------------------------------
// Snapshot trees
// ---------------------------------------------------------------------------

const SNAPSHOT_NODE_TYPES = [
  'XCUIElementTypeWindow',
  'XCUIElementTypeButton',
  'XCUIElementTypeStaticText',
  'XCUIElementTypeTextField',
  'XCUIElementTypeCell',
  'android.widget.TextView',
  'android.widget.Button',
] as const;

const SNAPSHOT_LABELS = ['Increment', 'Submit', 'Email', '67', '', 'Ünïcøde', 'a b c'] as const;

/** A snapshot tree shaped like a rendered one: sequential indexes, bounded depth. */
export const rawSnapshotNodesArb: fc.Arbitrary<RawSnapshotNode[]> = fc
  .array(
    fc.record({
      type: fc.constantFrom(...SNAPSHOT_NODE_TYPES),
      label: fc.option(fc.constantFrom(...SNAPSHOT_LABELS), { nil: undefined }),
      value: fc.option(fc.constantFrom(...SNAPSHOT_LABELS), { nil: undefined }),
      depth: fc.integer({ min: 0, max: 3 }),
      enabled: fc.boolean(),
      selected: fc.boolean(),
      hittable: fc.boolean(),
    }),
    { maxLength: 12 },
  )
  .map((nodes) => nodes.map((node, index) => ({ ...node, index })));

// ---------------------------------------------------------------------------
// `.ad` script lines
// ---------------------------------------------------------------------------

const scriptTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Submit', 'Log in', 'a "quoted" label', "it's fine", 'tab\tseparated', 'Ünïcøde'),
  fc.string({ minLength: 1, maxLength: 10 }),
);

const scriptTargetArb: fc.Arbitrary<string> = fc.oneof(
  refArb.map(formatRef),
  scriptTextArb.map((text) => JSON.stringify(`label=${text}`)),
);

const coordinateArb = fc.integer({ min: 0, max: 1200 }).map(String);

/**
 * A command is either generated from a line template or explicitly waived with
 * the reason it needs none. `Record<PublicCommandName, …>` makes the
 * classification exhaustive: a new public command does not compile until it is
 * given a template or a waiver.
 */
/**
 * Every command name a `.ad` line can carry. Internal commands are included
 * because scripts record them too (`runtime` has its own parse/print branch).
 */
type ReplayCommandName =
  | (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS]
  | (typeof INTERNAL_COMMANDS)[keyof typeof INTERNAL_COMMANDS];

type ReplayLinePlan = fc.Arbitrary<string> | { waived: string };

/**
 * Commands whose `.ad` line is a bare `<command> <token>…` handled by the
 * generic parse/print branch (`appendGenericActionScriptArgs`), whose shape the
 * `wait`/`longpress` templates already exercise. A command that grows its own
 * branch in src/replay/script.ts or src/replay/script-formatting.ts must move
 * to a template.
 */
const GENERIC_REPLAY_LINE = {
  waived: 'generic line shape, covered by the wait/longpress templates',
} as const;

const REPLAY_SCRIPT_LINE_PLANS = {
  click: fc.oneof(
    scriptTargetArb.map((target) => `click ${target}`),
    fc.tuple(coordinateArb, coordinateArb).map(([x, y]) => `click ${x} ${y}`),
    fc
      .tuple(scriptTargetArb, fc.integer({ min: 1, max: 5 }))
      .map(([target, count]) => `click ${target} --count ${count}`),
  ),
  press: fc.oneof(
    scriptTargetArb.map((target) => `press ${target}`),
    fc
      .tuple(scriptTargetArb, fc.constantFrom('primary', 'secondary', 'middle'))
      .map(([target, button]) => `press ${target} --button ${button}`),
  ),
  longpress: scriptTargetArb.map((target) => `longpress ${target}`),
  hover: scriptTargetArb.map((target) => `hover ${target}`),
  wait: fc
    .tuple(scriptTargetArb, fc.integer({ min: 100, max: 5000 }))
    .map(([target, timeout]) => `wait ${target} ${timeout}`),
  fill: fc
    .tuple(scriptTargetArb, scriptTextArb)
    .map(([target, text]) => `fill ${target} ${JSON.stringify(text)}`),
  type: scriptTextArb.map((text) => `type ${JSON.stringify(text)}`),
  get: fc
    .tuple(fc.constantFrom('text', 'value', 'label'), scriptTargetArb)
    .map(([property, target]) => `get ${property} ${target}`),
  swipe: fc
    .tuple(coordinateArb, coordinateArb, coordinateArb, coordinateArb)
    .map((coordinates) => `swipe ${coordinates.join(' ')}`),
  gesture: fc.oneof(
    fc
      .tuple(coordinateArb, coordinateArb, coordinateArb, coordinateArb)
      .map((coordinates) => `gesture pan ${coordinates.join(' ')}`),
    fc
      .tuple(fc.constantFrom(...SCROLL_DIRECTIONS), coordinateArb, coordinateArb)
      .map(([direction, x, y]) => `gesture fling ${direction} ${x} ${y}`),
    fc.constantFrom(...SWIPE_PRESETS).map((preset) => `gesture swipe ${preset}`),
    fc.integer({ min: -180, max: 180 }).map((degrees) => `gesture rotate ${degrees}`),
  ),
  snapshot: fc.oneof(
    fc.constant('snapshot'),
    fc.constant('snapshot -i'),
    fc.integer({ min: 0, max: 6 }).map((depth) => `snapshot -d ${depth}`),
    scriptTextArb.map((scope) => `snapshot -s ${JSON.stringify(scope)}`),
  ),
  screenshot: fc.constantFrom('screenshot', 'screenshot out.png'),
  open: fc.oneof(
    fc.constantFrom('open com.example.app', 'open com.example.app --relaunch'),
    fc
      .tuple(fc.constantFrom('ios', 'android'), fc.integer({ min: 1, max: 65_535 }))
      .map(
        ([platform, port]) => `open com.example.app --platform ${platform} --metro-port ${port}`,
      ),
  ),
  runtime: fc.oneof(
    fc.constant('runtime metro'),
    fc.constantFrom('ios', 'android').map((platform) => `runtime metro --platform ${platform}`),
  ),
  record: fc.oneof(
    fc.constantFrom('record start', 'record stop', 'record start --hide-touches'),
    fc.integer({ min: 1, max: 120 }).map((fps) => `record start --fps ${fps}`),
  ),
  alert: GENERIC_REPLAY_LINE,
  'app-switcher': GENERIC_REPLAY_LINE,
  apps: GENERIC_REPLAY_LINE,
  appstate: GENERIC_REPLAY_LINE,
  artifacts: GENERIC_REPLAY_LINE,
  audio: GENERIC_REPLAY_LINE,
  back: GENERIC_REPLAY_LINE,
  batch: GENERIC_REPLAY_LINE,
  boot: GENERIC_REPLAY_LINE,
  capabilities: GENERIC_REPLAY_LINE,
  clipboard: GENERIC_REPLAY_LINE,
  close: GENERIC_REPLAY_LINE,
  devices: GENERIC_REPLAY_LINE,
  diff: GENERIC_REPLAY_LINE,
  doctor: GENERIC_REPLAY_LINE,
  events: GENERIC_REPLAY_LINE,
  find: GENERIC_REPLAY_LINE,
  focus: GENERIC_REPLAY_LINE,
  home: GENERIC_REPLAY_LINE,
  install: GENERIC_REPLAY_LINE,
  'install-from-source': GENERIC_REPLAY_LINE,
  is: GENERIC_REPLAY_LINE,
  keyboard: GENERIC_REPLAY_LINE,
  logs: GENERIC_REPLAY_LINE,
  network: GENERIC_REPLAY_LINE,
  orientation: GENERIC_REPLAY_LINE,
  perf: GENERIC_REPLAY_LINE,
  prepare: GENERIC_REPLAY_LINE,
  push: GENERIC_REPLAY_LINE,
  'react-native': GENERIC_REPLAY_LINE,
  reinstall: GENERIC_REPLAY_LINE,
  replay: GENERIC_REPLAY_LINE,
  scroll: GENERIC_REPLAY_LINE,
  settings: GENERIC_REPLAY_LINE,
  shutdown: GENERIC_REPLAY_LINE,
  test: GENERIC_REPLAY_LINE,
  trace: GENERIC_REPLAY_LINE,
  'trigger-app-event': GENERIC_REPLAY_LINE,
  'tv-remote': GENERIC_REPLAY_LINE,
  viewport: GENERIC_REPLAY_LINE,
  install_source: GENERIC_REPLAY_LINE,
  lease_allocate: GENERIC_REPLAY_LINE,
  lease_heartbeat: GENERIC_REPLAY_LINE,
  lease_release: GENERIC_REPLAY_LINE,
  release_materialized_paths: GENERIC_REPLAY_LINE,
  session_list: GENERIC_REPLAY_LINE,
  session_save_script: GENERIC_REPLAY_LINE,
} satisfies Record<ReplayCommandName, ReplayLinePlan>;

/**
 * Line templates for every command, resolved through the runtime command
 * catalog so a command that exists at runtime but not in the plan fails loudly.
 */
function replayScriptLineArbs(): fc.Arbitrary<string>[] {
  const arbitraries: fc.Arbitrary<string>[] = [];
  const commands: ReplayCommandName[] = [
    ...Object.values(PUBLIC_COMMANDS),
    ...Object.values(INTERNAL_COMMANDS),
  ];
  for (const command of commands) {
    const plan: ReplayLinePlan | undefined = REPLAY_SCRIPT_LINE_PLANS[command];
    if (plan === undefined) {
      throw new Error(
        `replay command "${command}" from src/command-catalog.ts is unclassified: ` +
          'add a line template or a waiver to REPLAY_SCRIPT_LINE_PLANS in ' +
          'src/__tests__/test-utils/property-arbitraries.ts',
      );
    }
    if (!('waived' in plan)) arbitraries.push(plan);
  }
  return arbitraries;
}

const replayScriptLineArb: fc.Arbitrary<string> = fc.oneof(...replayScriptLineArbs());

/** A valid `.ad` script: action lines interleaved with comments and blank lines. */
export const replayScriptArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 8, arbitrary: replayScriptLineArb },
      { weight: 1, arbitrary: fc.constantFrom('# a comment', '') },
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((lines) => `${lines.join('\n')}\n`);
