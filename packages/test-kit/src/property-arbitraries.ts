import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import fc from 'fast-check';

/**
 * Shared fast-check generators for the pure parse/print and geometry kernels
 * (#1413). Each property lives in its owning module's test file; the inputs
 * live here so the hazard vocabulary (quote/apostrophe/escape shapes, compact
 * viewports, pinned refs) is written once and every property inherits the next
 * hazard someone adds.
 *
 * fast-check reports the SHRUNK counterexample plus the seed/path to replay it,
 * so a failure names a minimal input rather than the raw random one.
 *
 * `PROPERTY_RUNS` and the interaction touch-point/rect arbitraries live in
 * `@agent-device/selectors/snapshot-geometry-fixtures` (#2402) — the canonical location
 * both this file and the selectors package build on.
 */

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
