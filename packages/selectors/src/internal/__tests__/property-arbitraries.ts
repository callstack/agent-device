import fc from 'fast-check';
import { attachRefs, type Rect, type SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SelectorKey, SelectorTerm } from '../parse.ts';

export const PROPERTY_RUNS = 100;

// ---------------------------------------------------------------------------
// Rects / viewports
// ---------------------------------------------------------------------------

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

const SELECTOR_KEY_VALUE_KINDS = {
  id: 'text',
  role: 'text',
  text: 'text',
  label: 'text',
  value: 'text',
  appname: 'text',
  windowtitle: 'text',
  visible: 'boolean',
  hidden: 'boolean',
  editable: 'boolean',
  selected: 'boolean',
  focused: 'boolean',
  enabled: 'boolean',
  hittable: 'boolean',
} satisfies Record<SelectorKey, 'text' | 'boolean'>;

const SELECTOR_KEY_NAMES: readonly SelectorKey[] = Object.keys(
  SELECTOR_KEY_VALUE_KINDS,
) as SelectorKey[];

function selectorKeysOfKind(kind: 'text' | 'boolean'): SelectorKey[] {
  return SELECTOR_KEY_NAMES.filter((key) => SELECTOR_KEY_VALUE_KINDS[key] === kind);
}

const SELECTOR_VALUE_HAZARDS = [
  '',
  ' ',
  '"',
  "'",
  "it's",
  'say "hi"',
  '\\',
  String.raw`\"`,
  String.raw`a\\b`,
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
      key: fc.constantFrom(...selectorKeysOfKind('text')),
      value: selectorTextValueArb,
    })
    .map(({ key, value }) => ({ key, value })),
  fc
    .record({
      key: fc.constantFrom(...selectorKeysOfKind('boolean')),
      value: fc.boolean(),
    })
    .map(({ key, value }) => ({ key, value })),
);

export type GeneratedSelectorChain = {
  selectors: SelectorTerm[][];
  expression: string;
};

export const selectorChainArb: fc.Arbitrary<GeneratedSelectorChain> = fc
  .record({
    selectors: fc.array(fc.array(selectorTermArb, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 3,
    }),
    bareBooleans: fc.boolean(),
  })
  .map(({ selectors, bareBooleans }) => ({
    selectors,
    expression: formatSelectorChainExpression(selectors, { bareBooleans }),
  }));

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
