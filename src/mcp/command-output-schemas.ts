import type { JsonSchema } from '../commands/command-contract.ts';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import { commandSupportsSettleObservation } from '@agent-device/command-registry/registry';
import {
  booleanSchema,
  constSchema,
  enumSchema,
  numberSchema,
  objectSchema,
  stringArraySchema,
  stringSchema,
} from '../commands/command-input.ts';
import { WAIT_COMMAND_OUTPUT_SCHEMAS } from '../commands/capture/wait.ts';
import { PREPARE_COMMAND_OUTPUT_SCHEMAS } from '../commands/management/prepare.ts';
import { DOCTOR_COMMAND_OUTPUT_SCHEMAS } from '../commands/management/doctor.ts';
import { DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS } from '../commands/management/device.ts';
import { PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS } from '../commands/management/push.ts';
import { VIEWPORT_COMMAND_OUTPUT_SCHEMAS } from '../commands/management/viewport.ts';
import {
  INTERACTION_COMMAND_OUTPUT_SCHEMAS,
  postActionSurfaceChangeSchema,
} from '../commands/interaction/index.ts';
import { RECORDING_COMMAND_OUTPUT_SCHEMAS } from '../commands/recording/output-schemas.ts';
import { REPLAY_COMMAND_OUTPUT_SCHEMAS } from '../commands/replay/index.ts';
import { SYSTEM_COMMAND_OUTPUT_SCHEMAS } from '../commands/system/index.ts';

/**
 * Registry of per-command MCP `outputSchema`s, keyed by the daemon command
 * NAME. It is type-tied to the typed-result spine `CommandResultMap`
 * (@agent-device/command-registry/command-result) via
 * `satisfies Record<keyof CommandResultMap, JsonSchema>`, so the one-for-one
 * invariant is compiler-enforced: a new `CommandResultMap` entry without a schema
 * here is a missing-key error, and a typo'd/extra key is an excess-property error.
 * The genuinely-dynamic commands (snapshot overlays, gestures, perf, logs, …) are
 * absent from BOTH maps — their tools stay byte-identical to today (no
 * `outputSchema` key), exactly as `CommandResultMap` omits them rather than
 * inventing a shape.
 *
 * There is no type→JSON-Schema generator in this repo. Schemas are hand-authored from
 * matching contract types, using the shared JSON-Schema primitives in
 * `src/commands/command-input.ts`. Where a command family is owned by one module (the
 * descriptors' `ownerFiles`), that module authors its entries and projects them into this
 * map instead of being hand-listed here. Two invariants:
 *  - NEVER strict: no `additionalProperties: false` anywhere, so the additive
 *    `cost` object (opted in via `--cost` / `includeCost`) and any other additive
 *    fields ride into `structuredContent` and still validate.
 *  - Accurate, never invented: required-vs-optional, enums, `const` discriminants
 *    and discriminated-union branches mirror the source contract types.
 *
 * The opt-in `--settle` observation (#1101) is not hand-listed per entry: the
 * base map carries none and `deriveSettleObservationSchemas` grafts it onto
 * exactly the entries whose descriptor declares the post-action observation
 * trait (#1652).
 */

// SettleObservation (packages/contracts/src/interaction.ts) — opt-in `--settle` settled
// diff observation (#1101).
const settleObservationSchema: JsonSchema = objectSchema(
  {
    settled: booleanSchema(
      'Whether the UI held the quiet window before the deadline. false is advisory, not failure.',
    ),
    waitedMs: numberSchema(),
    captures: numberSchema(),
    quietMs: numberSchema(),
    timeoutMs: numberSchema(),
    refsGeneration: numberSchema(
      'Snapshot generation of the stored settled tree; refs on added diff lines were minted from it.',
    ),
    refs: {
      type: 'array',
      items: objectSchema(
        {
          ref: stringSchema('Plain ref body (e12) minted from the stored settled tree.'),
        },
        ['ref'],
      ),
    },
    surfaceChange: postActionSurfaceChangeSchema,
    diff: objectSchema(
      {
        summary: objectSchema(
          {
            additions: numberSchema(),
            removals: numberSchema(),
            unchanged: numberSchema(),
          },
          ['additions', 'removals', 'unchanged'],
        ),
        lines: {
          type: 'array',
          items: objectSchema(
            {
              kind: enumSchema(['added', 'removed']),
              text: stringSchema(),
              ref: stringSchema('Plain ref body (e12) for added lines.'),
            },
            ['kind', 'text'],
          ),
        },
        truncated: booleanSchema('Lines were capped to the response bound.'),
      },
      ['summary', 'lines'],
      'Settled diff vs the pre-action tree (changed lines only).',
    ),
    tail: {
      type: 'array',
      description:
        'Unchanged interactive refs tail: still-present, actionable elements from the settled tree, attached only when diff carries zero added-line refs (a modal-dismiss/toast-only diff).',
      items: objectSchema(
        {
          ref: stringSchema('Plain ref body (e12) minted from the stored settled tree.'),
          role: stringSchema(),
          label: stringSchema(),
        },
        ['ref', 'role'],
      ),
    },
    tailTruncated: booleanSchema('Present (true) when tail candidates exceeded the response cap.'),
    hint: stringSchema(),
  },
  ['settled', 'waitedMs', 'captures', 'quietMs', 'timeoutMs'],
);

/** Grafts the opt-in `--settle` observation onto a closed schema or union branch. */
function withSettleObservation(schema: JsonSchema): JsonSchema {
  // Union-shaped results (fill) carry the observation in EACH branch, never
  // next to the oneOf.
  if (schema.oneOf) {
    return { ...schema, oneOf: schema.oneOf.map(withSettleObservation) };
  }
  return {
    ...schema,
    properties: { ...(schema.properties ?? {}), settle: settleObservationSchema },
  };
}

/**
 * #1652: whether a command's output schema advertises `settle` derives from
 * its descriptor post-action observation trait instead of hand-listed
 * properties per schema. The base map below carries no settle property
 * anywhere; this pass grafts it onto exactly the trait-capable entries.
 * Copies only — press and click share one base schema object, so an in-place
 * graft would leak across them.
 */
function deriveSettleObservationSchemas(
  schemas: Record<keyof CommandResultMap, JsonSchema>,
): Record<keyof CommandResultMap, JsonSchema> {
  const derived: Record<keyof CommandResultMap, JsonSchema> = { ...schemas };
  for (const command of Object.keys(derived) as Array<keyof CommandResultMap>) {
    if (!commandSupportsSettleObservation(command)) continue;
    derived[command] = withSettleObservation(derived[command]);
  }
  return derived;
}

const BASE_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/scroll-command.ts — ScrollCommandResult. The
  // settle-capable generic-route pair must both be typed so the trait
  // derivation grafts the observation onto each (#1652); platform leaves add
  // gesture-plan coordinates on top, which the non-strict schema admits.
  scroll: objectSchema(
    {
      direction: enumSchema(['up', 'down', 'left', 'right']),
      edge: enumSchema(['top', 'bottom']),
      until: stringSchema('Until scrolls only: the selector the passes stopped on.'),
      passes: numberSchema('Edge and until scrolls only: how many scroll-and-check passes ran.'),
      amount: numberSchema(),
      pixels: numberSchema(),
      durationMs: numberSchema(),
      message: stringSchema(),
      keyboardAvoided: booleanSchema(
        'Present only when an on-screen keyboard forced the swipe into the band above it; the reported pixels were planned against the shorter referenceHeight.',
      ),
      keyboardMinY: numberSchema(
        'Where the keyboard began, in the same unit as the gesture coordinates. Clipped scrolls only.',
      ),
      movement: enumSchema(
        ['moved', 'at-edge', 'unchanged', 'unobserved'],
        'Directional scrolls only: what the owner observed after its gesture. `moved` means the content inside the scroller the swipe ran in differs from the tree the session stored immediately before the gesture; `at-edge` and `unchanged` mean it did not change, with no hidden content left to reveal and with no end-of-content signal to read, respectively; `unobserved` means the pair could not back a claim in either direction — nothing comparable was available (no stored tree, a capture from another lineage, a surface that never came to rest), or every difference sits outside the scroller that was swiped, which a changing status bar does on Android — so the reported distance rests on the gesture plan alone. The field is absent — which is never a claim that nothing moved — on the tiers that verify per pass (`scroll top`/`bottom`, `--until`), on a runtime bound without a capture, on a platform whose scroll dispatches no swipe (the Linux wheel), and where the caller already owns that observation (`--settle`, or a replay with `postGestureStabilization: false`).',
      ),
    },
    ['direction'],
  ),

  // packages/contracts/src/diff.ts — the public Node command accepts snapshot diffs.
  diff: objectSchema(
    {
      mode: constSchema('snapshot'),
      baselineInitialized: booleanSchema(),
      summary: objectSchema(
        {
          additions: numberSchema(),
          removals: numberSchema(),
          unchanged: numberSchema(),
        },
        ['additions', 'removals', 'unchanged'],
      ),
      lines: {
        type: 'array',
        items: objectSchema(
          {
            kind: enumSchema(['added', 'removed']),
            text: stringSchema(),
            ref: stringSchema(),
          },
          ['kind', 'text'],
        ),
      },
      warnings: stringArraySchema(),
    },
    ['mode', 'baselineInitialized', 'summary', 'lines'],
  ),

  // A family that owns its commands authors their advertised response shape beside the
  // command surface and projects it here. This spread stays last: a hand-written entry for
  // a projected command then fails as TS2783 instead of quietly overriding the family's,
  // and this map's `satisfies` still refuses a missing `CommandResultMap` key.
  ...WAIT_COMMAND_OUTPUT_SCHEMAS,
  ...PREPARE_COMMAND_OUTPUT_SCHEMAS,
  ...DOCTOR_COMMAND_OUTPUT_SCHEMAS,
  ...DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS,
  ...PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS,
  ...VIEWPORT_COMMAND_OUTPUT_SCHEMAS,
  ...INTERACTION_COMMAND_OUTPUT_SCHEMAS,
  ...RECORDING_COMMAND_OUTPUT_SCHEMAS,
  ...REPLAY_COMMAND_OUTPUT_SCHEMAS,
  ...SYSTEM_COMMAND_OUTPUT_SCHEMAS,
} satisfies Record<keyof CommandResultMap, JsonSchema>;

export const COMMAND_OUTPUT_SCHEMAS = deriveSettleObservationSchemas(BASE_COMMAND_OUTPUT_SCHEMAS);
