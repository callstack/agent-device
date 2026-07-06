import type { JsonSchema } from '../commands/command-contract.ts';
import type { CommandResultMap } from '../core/command-descriptor/command-result.ts';
import { booleanSchema, looseObjectSchema, stringSchema } from '../commands/command-input.ts';
import { BACK_MODES } from '../core/back-mode.ts';
import { DEVICE_ROTATIONS } from '../core/device-rotation.ts';
import { SESSION_SURFACES } from '../core/session-surface.ts';
import { DEVICE_TARGETS, PLATFORMS } from '../kernel/device.ts';

/**
 * Hand-authored registry of per-command MCP `outputSchema`s, keyed by the daemon
 * command NAME. It is type-tied to the typed-result spine `CommandResultMap`
 * (src/core/command-descriptor/command-result.ts) via
 * `satisfies Record<keyof CommandResultMap, JsonSchema>`, so the one-for-one
 * invariant is compiler-enforced: a new `CommandResultMap` entry without a schema
 * here is a missing-key error, and a typo'd/extra key is an excess-property error.
 * The genuinely-dynamic commands (snapshot overlays, gestures, perf, logs, …) are
 * absent from BOTH maps — their tools stay byte-identical to today (no
 * `outputSchema` key), exactly as `CommandResultMap` omits them rather than
 * inventing a shape.
 *
 * There is no type→JSON-Schema generator in this repo, so every schema below is
 * authored by hand from the matching contract type. Two invariants:
 *  - NEVER strict: no `additionalProperties: false` anywhere, so the additive
 *    `cost` object (opted in via `--cost` / `includeCost`) and any other additive
 *    fields ride into `structuredContent` and still validate.
 *  - Accurate, never invented: required-vs-optional, enums, `const` discriminants
 *    and discriminated-union branches mirror the source contract types.
 */

const DEVICE_KINDS = ['simulator', 'emulator', 'device'] as const;

function numberSchema(description?: string): JsonSchema {
  return { type: 'number', ...(description ? { description } : {}) };
}

function enumSchema(values: readonly string[], description?: string): JsonSchema {
  return { type: 'string', enum: values, ...(description ? { description } : {}) };
}

function constSchema(value: string): JsonSchema {
  return { type: 'string', const: value };
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  description?: string,
): JsonSchema {
  // Intentionally non-strict (no additionalProperties: false) so additive
  // fields such as `cost` validate.
  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

const stringArraySchema: JsonSchema = { type: 'array', items: { type: 'string' } };

const rectSchema: JsonSchema = objectSchema(
  {
    x: numberSchema(),
    y: numberSchema(),
    width: numberSchema(),
    height: numberSchema(),
  },
  ['x', 'y', 'width', 'height'],
);

const pointSchema: JsonSchema = objectSchema({ x: numberSchema(), y: numberSchema() }, ['x', 'y']);

// SnapshotNode = RawSnapshotNode & { ref } (src/kernel/snapshot.ts). `index` and
// `ref` are the only always-present fields; all others are optional.
const snapshotNodeSchema: JsonSchema = objectSchema(
  {
    index: numberSchema(),
    ref: stringSchema('Stable snapshot ref such as e12.'),
    type: stringSchema(),
    role: stringSchema(),
    subrole: stringSchema(),
    label: stringSchema(),
    value: stringSchema(),
    identifier: stringSchema(),
    rect: rectSchema,
    enabled: booleanSchema(),
    selected: booleanSchema(),
    focused: booleanSchema(),
    visibleToUser: booleanSchema(),
    hittable: booleanSchema(),
    depth: numberSchema(),
    parentIndex: numberSchema(),
    pid: numberSchema(),
    bundleId: stringSchema(),
    appName: stringSchema(),
    windowTitle: stringSchema(),
    surface: stringSchema(),
    hiddenContentAbove: booleanSchema(),
    hiddenContentBelow: booleanSchema(),
    interactionBlocked: enumSchema(['covered']),
    presentationHints: stringArraySchema,
  },
  ['index', 'ref'],
  'Resolved snapshot node for the matched element.',
);

const resolvedRefTargetSchema: JsonSchema = objectSchema(
  { kind: constSchema('ref'), ref: stringSchema() },
  ['kind', 'ref'],
);

const resolvedSelectorTargetSchema: JsonSchema = objectSchema(
  { kind: constSchema('selector'), selector: stringSchema() },
  ['kind', 'selector'],
);

type InteractionExtra = {
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
};

/**
 * `ResolvedInteractionTarget & extra` — a `kind` discriminated union (point / ref
 * / selector) shared by press / fill / longpress. The `const` discriminant keeps
 * the branches mutually exclusive, so the additive `cost` field never breaks the
 * exactly-one-of contract.
 */
function interactionResultSchema(extra: InteractionExtra = {}): JsonSchema {
  const extraProperties = extra.properties ?? {};
  const extraRequired = extra.required ?? [];
  const pointBranch = objectSchema(
    { kind: constSchema('point'), point: pointSchema, ...extraProperties },
    ['kind', 'point', ...extraRequired],
  );
  const refBranch = objectSchema(
    {
      kind: constSchema('ref'),
      point: pointSchema,
      target: resolvedRefTargetSchema,
      node: snapshotNodeSchema,
      selectorChain: stringArraySchema,
      refLabel: stringSchema(),
      targetHittable: booleanSchema(),
      hint: stringSchema(),
      ...extraProperties,
    },
    ['kind', 'target', ...extraRequired],
  );
  const selectorBranch = objectSchema(
    {
      kind: constSchema('selector'),
      point: pointSchema,
      target: resolvedSelectorTargetSchema,
      node: snapshotNodeSchema,
      selectorChain: stringArraySchema,
      refLabel: stringSchema(),
      targetHittable: booleanSchema(),
      hint: stringSchema(),
      ...extraProperties,
    },
    ['kind', 'point', 'target', 'node', 'selectorChain', ...extraRequired],
  );
  return { type: 'object', oneOf: [pointBranch, refBranch, selectorBranch] };
}

const backendResultSchema = looseObjectSchema('Raw backend result passthrough.');

// InteractionEvidence (src/contracts/interaction.ts) — opt-in `--verify` cheap
// post-condition evidence (#1047).
const interactionEvidenceSchema: JsonSchema = objectSchema(
  {
    foregroundApp: stringSchema('Foreground app bundle id or name, when the capture carries it.'),
    nodeCount: numberSchema('Node count in the post-action interactive-only capture.'),
    interactiveNodeCount: numberSchema('Subset of nodeCount the platform reports as hittable.'),
    digest: stringSchema('Order-independent digest of the post-action node multiset.'),
    changedFromBefore: booleanSchema(
      'Whether the post-action digest differs from the pre-action capture digest. false is evidence, not failure.',
    ),
  },
  ['nodeCount', 'interactiveNodeCount', 'digest', 'changedFromBefore'],
);

// SettleObservation (src/contracts/interaction.ts) — opt-in `--settle` settled
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
    hint: stringSchema(),
  },
  ['settled', 'waitedMs', 'captures', 'quietMs', 'timeoutMs'],
);

// boot / shutdown share the resolved-device header (src/contracts/device.ts).
const deviceHeaderProperties: Record<string, JsonSchema> = {
  platform: enumSchema(PLATFORMS),
  target: enumSchema(DEVICE_TARGETS),
  device: stringSchema('Human-readable device name.'),
  id: stringSchema('Stable device id.'),
  kind: enumSchema(DEVICE_KINDS),
};
const deviceHeaderRequired = ['platform', 'target', 'device', 'id', 'kind'] as const;

// TargetShutdownResult (src/target-shutdown-contract.ts).
const targetShutdownResultSchema: JsonSchema = objectSchema(
  {
    success: booleanSchema(),
    exitCode: numberSchema(),
    stdout: stringSchema(),
    stderr: stringSchema(),
    error: looseObjectSchema('Normalized error detail when shutdown failed.'),
  },
  ['success', 'exitCode', 'stdout', 'stderr'],
);

export const COMMAND_OUTPUT_SCHEMAS = {
  // src/contracts/interaction.ts
  press: interactionResultSchema({
    properties: {
      backendResult: backendResultSchema,
      message: stringSchema(),
      warning: stringSchema(),
      evidence: interactionEvidenceSchema,
      settle: settleObservationSchema,
    },
  }),
  fill: interactionResultSchema({
    properties: {
      text: stringSchema('Text submitted to the field.'),
      warning: stringSchema(),
      backendResult: backendResultSchema,
      message: stringSchema(),
      evidence: interactionEvidenceSchema,
      settle: settleObservationSchema,
    },
    required: ['text'],
  }),
  longpress: interactionResultSchema({
    properties: {
      durationMs: numberSchema(),
      backendResult: backendResultSchema,
      message: stringSchema(),
      warning: stringSchema(),
      settle: settleObservationSchema,
    },
  }),

  // src/contracts/device.ts
  boot: objectSchema({ ...deviceHeaderProperties, booted: { type: 'boolean', const: true } }, [
    ...deviceHeaderRequired,
    'booted',
  ]),
  shutdown: objectSchema({ ...deviceHeaderProperties, shutdown: targetShutdownResultSchema }, [
    ...deviceHeaderRequired,
    'shutdown',
  ]),

  // src/contracts/viewport.ts
  viewport: objectSchema(
    { width: numberSchema(), height: numberSchema(), message: stringSchema() },
    ['width', 'height', 'message'],
  ),

  // src/contracts/navigation.ts
  home: objectSchema({ action: constSchema('home'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  back: objectSchema(
    { action: constSchema('back'), mode: enumSchema(BACK_MODES), message: stringSchema() },
    ['action', 'mode', 'message'],
  ),
  rotate: objectSchema(
    {
      action: constSchema('rotate'),
      orientation: enumSchema(DEVICE_ROTATIONS),
      message: stringSchema(),
    },
    ['action', 'orientation', 'message'],
  ),
  'app-switcher': objectSchema({ action: constSchema('app-switcher'), message: stringSchema() }, [
    'action',
    'message',
  ]),

  // src/contracts/clipboard.ts — discriminated union on `action`.
  clipboard: {
    type: 'object',
    oneOf: [
      objectSchema({ action: constSchema('read'), text: stringSchema() }, ['action', 'text']),
      objectSchema(
        { action: constSchema('write'), textLength: numberSchema(), message: stringSchema() },
        ['action', 'textLength', 'message'],
      ),
    ],
  },

  // src/contracts/app-state.ts — discriminated union on `platform`.
  appstate: {
    type: 'object',
    oneOf: [
      objectSchema(
        {
          platform: enumSchema(['ios', 'macos']),
          appName: stringSchema(),
          appBundleId: stringSchema(),
          source: constSchema('session'),
          surface: enumSchema(SESSION_SURFACES),
          device_udid: stringSchema('iOS only — the session device UDID.'),
          ios_simulator_device_set: {
            type: ['string', 'null'],
            description: 'iOS only — the simulator set path, or null when unknown.',
          },
        },
        ['platform', 'appName', 'source', 'surface'],
      ),
      objectSchema(
        {
          platform: constSchema('android'),
          package: stringSchema(),
          activity: stringSchema(),
        },
        ['platform', 'package', 'activity'],
      ),
    ],
  },

  // src/contracts/keyboard.ts — flat closed shape; `platform`/`action` always present.
  keyboard: objectSchema(
    {
      platform: enumSchema(['android', 'ios']),
      action: enumSchema(['status', 'dismiss', 'enter']),
      visible: booleanSchema(),
      wasVisible: booleanSchema(),
      dismissed: booleanSchema(),
      attempts: numberSchema(),
      inputType: stringSchema(),
      type: enumSchema(['text', 'number', 'email', 'phone', 'password', 'datetime', 'unknown']),
      inputMethodPackage: stringSchema(),
      focusedPackage: stringSchema(),
      focusedResourceId: stringSchema(),
      inputOwner: enumSchema(['app', 'ime', 'unknown']),
      message: stringSchema(),
    },
    ['platform', 'action'],
  ),
} satisfies Record<keyof CommandResultMap, JsonSchema>;
