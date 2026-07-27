import fc from 'fast-check';
import { GESTURE_KINDS, type GesturePayload } from '../../contracts/gesture-input.ts';
import { SCROLL_DIRECTIONS, SWIPE_PRESETS } from '../../contracts/scroll-gesture.ts';
import type { Point, RawSnapshotNode, Rect } from '../../kernel/snapshot.ts';
import type { SelectorKey, SelectorTerm } from '../../selectors/parse.ts';

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
// Selectors
// ---------------------------------------------------------------------------

const SELECTOR_TEXT_KEYS = [
  'id',
  'role',
  'text',
  'label',
  'value',
  'appname',
  'windowtitle',
] as const satisfies readonly SelectorKey[];

const SELECTOR_BOOLEAN_KEYS = [
  'visible',
  'hidden',
  'editable',
  'selected',
  'focused',
  'enabled',
  'hittable',
] as const satisfies readonly SelectorKey[];

/**
 * The shapes that broke hand-written selector examples: both quote characters,
 * backslash runs before a quote, the `||` fallback separator and `=` inside a
 * value, whitespace-only values, and non-BMP text.
 */
const SELECTOR_VALUE_HAZARDS = [
  '',
  ' ',
  '"',
  "'",
  "it's",
  'say "hi"',
  '\\',
  '\\"',
  'a\\\\b',
  'a || b',
  'key=value',
  'line\nbreak',
  '\tTab',
  'Ünïcøde',
  '😀 emoji',
] as const;

const selectorTextValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SELECTOR_VALUE_HAZARDS),
  fc.string({ minLength: 0, maxLength: 12 }),
  fc
    .array(fc.constantFrom(...SELECTOR_VALUE_HAZARDS), { minLength: 2, maxLength: 3 })
    .map((parts) => parts.join('')),
);

const selectorTermArb: fc.Arbitrary<SelectorTerm> = fc.oneof(
  fc
    .record({
      key: fc.constantFrom(...SELECTOR_TEXT_KEYS),
      value: selectorTextValueArb,
    })
    // fast-check records are null-prototype; parsed terms are plain objects.
    .map(({ key, value }) => ({ key, value })),
  fc
    .record({
      key: fc.constantFrom(...SELECTOR_BOOLEAN_KEYS),
      value: fc.boolean(),
    })
    .map(({ key, value }) => ({ key, value })),
);

export type GeneratedSelectorChain = {
  /** Terms per fallback segment, in source order. */
  selectors: SelectorTerm[][];
  /** A source expression for those terms; boolean terms may use the bare form. */
  expression: string;
};

/**
 * A selector chain plus one source expression that denotes it. `bareBooleans`
 * emits `visible` instead of `visible=true`, the other accepted spelling of a
 * true boolean term.
 */
export const selectorChainArb: fc.Arbitrary<GeneratedSelectorChain> = fc
  .record({
    selectors: fc.array(fc.array(selectorTermArb, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 3,
    }),
    bareBooleans: fc.boolean(),
  })
  .filter(({ selectors }) => selectors.length > 0)
  .map(({ selectors, bareBooleans }) => ({
    selectors,
    expression: formatSelectorChainExpression(selectors, { bareBooleans }),
  }));

/** Canonical printer: every text value quoted, every boolean term explicit. */
function formatSelectorTerm(term: SelectorTerm, options: { bareBooleans?: boolean } = {}): string {
  if (typeof term.value === 'boolean') {
    return options.bareBooleans && term.value ? term.key : `${term.key}=${term.value}`;
  }
  return `${term.key}=${JSON.stringify(term.value)}`;
}

export function formatSelectorChainExpression(
  selectors: readonly (readonly SelectorTerm[])[],
  options: { bareBooleans?: boolean } = {},
): string {
  return selectors
    .map((terms) => terms.map((term) => formatSelectorTerm(term, options)).join(' '))
    .join(' || ');
}

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
): Record<(typeof GESTURE_KINDS)[number], fc.Arbitrary<GesturePayload>> {
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
      gesture: fc.oneof(...GESTURE_KINDS.map((kind) => byKind[kind])),
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
 * One line arbitrary per replay command this property covers. The record is
 * keyed by literal command names so a renamed command breaks the generator
 * loudly instead of quietly narrowing coverage.
 */
const REPLAY_SCRIPT_LINE_ARBS = {
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
} satisfies Record<string, fc.Arbitrary<string>>;

const replayScriptLineArb: fc.Arbitrary<string> = fc.oneof(
  ...Object.values(REPLAY_SCRIPT_LINE_ARBS),
);

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
