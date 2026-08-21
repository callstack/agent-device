import type { JsonSchema } from '../commands/command-contract.ts';
import { projectedSystemCommandOutputSchemas } from '../commands/system/index.ts';
import type { CommandResultMap } from '../core/command-descriptor/command-result.ts';
import { commandSupportsSettleObservation } from '../core/command-descriptor/registry.ts';
import { booleanSchema, looseObjectSchema, stringSchema } from '../commands/command-input.ts';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import { DEVICE_TARGETS, PUBLIC_PLATFORMS } from '@agent-device/kernel/device';

/**
 * Registry of per-command MCP `outputSchema`s, keyed by the daemon command
 * NAME. It is type-tied to the typed-result spine `CommandResultMap`
 * (src/core/command-descriptor/command-result.ts) via
 * `satisfies Record<keyof CommandResultMap, JsonSchema>`, so the one-for-one
 * invariant is compiler-enforced: a new `CommandResultMap` entry without a schema
 * here is a missing-key error, and a typo'd/extra key is an excess-property error.
 * The genuinely-dynamic commands (snapshot overlays, gestures, perf, logs, …) are
 * absent from BOTH maps — their tools stay byte-identical to today (no
 * `outputSchema` key), exactly as `CommandResultMap` omits them rather than
 * inventing a shape.
 *
 * There is no type→JSON-Schema generator in this repo. Schemas remain
 * hand-authored from matching contract types; selected executable contracts can
 * project their colocated schema into this map. Two invariants:
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

export const DEVICE_KINDS = ['simulator', 'emulator', 'device'] as const;

function numberSchema(description?: string): JsonSchema {
  return { type: 'number', ...(description ? { description } : {}) };
}

function enumSchema(values: readonly string[], description?: string): JsonSchema {
  return { type: 'string', enum: values, ...(description ? { description } : {}) };
}

function constSchema(value: string): JsonSchema {
  return { type: 'string', const: value };
}

function nullableStringSchema(description?: string): JsonSchema {
  return { type: ['string', 'null'], ...(description ? { description } : {}) };
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

const responseCostSchema: JsonSchema = objectSchema(
  {
    wallClockMs: numberSchema('Total wall-clock time for the request in milliseconds.'),
    runnerRoundTrips: numberSchema(
      'Number of real runner round-trips made while serving the request.',
    ),
    nodeCount: numberSchema(
      'Number of nodes in the original node tree when the response carries one.',
    ),
  },
  ['wallClockMs', 'runnerRoundTrips'],
);

const artifactSchema = objectSchema(
  {
    field: stringSchema(),
    artifactType: stringSchema(),
    path: stringSchema(),
    localPath: stringSchema(),
    fileName: stringSchema(),
  },
  ['field'],
);

type InteractionExtra = {
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
};

/**
 * Canonical interaction response data built by buildInteractionResponseData:
 * shared target/coordinate/evidence fields plus per-command extras. The runtime
 * result still has richer internal node/backend data; this schema documents the
 * JSON payload returned to clients.
 */
function interactionResponseDataSchema(extra: InteractionExtra = {}): JsonSchema {
  const extraProperties = extra.properties ?? {};
  const extraRequired = extra.required ?? [];
  return objectSchema(
    {
      targetKind: enumSchema(['point', 'ref', 'selector'], 'Resolved interaction target kind.'),
      x: numberSchema('Resolved interaction x coordinate when available.'),
      y: numberSchema('Resolved interaction y coordinate when available.'),
      referenceWidth: numberSchema('Reference frame width for visualizing the interaction point.'),
      referenceHeight: numberSchema(
        'Reference frame height for visualizing the interaction point.',
      ),
      ref: stringSchema('Snapshot ref without the @ prefix when the target was an @ref.'),
      selector: stringSchema('Selector expression when the target was a selector.'),
      selectorChain: stringArraySchema,
      refLabel: stringSchema(),
      targetHittable: booleanSchema(),
      hint: stringSchema(),
      warning: stringSchema(),
      message: stringSchema(),
      evidence: interactionEvidenceSchema,
      resolution: resolutionDisclosureSchema,
      cost: responseCostSchema,
      maestroNonHittableCoordinateFallbackAllowed: booleanSchema(
        'Whether the direct iOS Maestro coordinate fallback was allowed for this selector.',
      ),
      maestroNonHittableCoordinateFallbackUsed: booleanSchema(
        'Whether the direct iOS Maestro coordinate fallback was actually used.',
      ),
      maestroFallbackReason: constSchema('non-hittable-coordinate'),
      ...extraProperties,
    },
    ['targetKind', ...extraRequired],
  );
}

// ResolutionDiagnosticEntry (packages/contracts/src/interaction.ts) — a disambiguation
// winner or losing alternative. Never a snapshot ref.
const resolutionDiagnosticEntrySchema: JsonSchema = objectSchema(
  {
    diagnosticRef: stringSchema(
      'Opaque non-@ diagnostic token. Never a snapshot ref: not issued via refsGeneration and cannot be pinned or reused as an @ref target. UTF-8 truncated to 256 bytes.',
    ),
    role: stringSchema('UTF-8 truncated to 256 bytes.'),
    label: stringSchema('UTF-8 truncated to 256 bytes.'),
  },
  ['diagnosticRef'],
);

// ResolutionDisclosure (packages/contracts/src/interaction.ts) — never ref-issuing;
// absent on paths where the guarantee is inapplicable (ADR 0012 decision 2).
// `alternatives` rides default/full levels only; the digest view omits it.
const resolutionDisclosureSchema: JsonSchema = {
  type: 'object',
  description:
    'Pre-action disclosure of how the acting path resolved its target. Absent when resolutionDisclosure is inapplicable for the path.',
  oneOf: [
    objectSchema(
      {
        source: constSchema('runtime'),
        phase: constSchema('pre-action'),
        kind: constSchema('unique'),
      },
      ['source', 'phase', 'kind'],
    ),
    objectSchema(
      {
        source: constSchema('runtime'),
        phase: constSchema('pre-action'),
        kind: constSchema('disambiguated'),
        matchCount: numberSchema('Total matches resolveSelectorChain found before disambiguation.'),
        winnerDiagnostic: resolutionDiagnosticEntrySchema,
        tiebreak: enumSchema(
          ['visible', 'deepest', 'smallest-area', 'structural-equivalence'],
          'The comparison that decided the winner.',
        ),
        alternatives: {
          type: 'array',
          description:
            'At most 5 losing candidates, document order. Present at default/full response levels and omitted in digest. The winner is never included.',
          items: resolutionDiagnosticEntrySchema,
        },
      },
      ['source', 'phase', 'kind', 'matchCount', 'winnerDiagnostic', 'tiebreak'],
    ),
    objectSchema(
      { source: constSchema('ref'), phase: constSchema('pre-action'), kind: constSchema('exact') },
      ['source', 'phase', 'kind'],
    ),
    objectSchema(
      {
        source: constSchema('ref'),
        phase: constSchema('pre-action'),
        kind: constSchema('label-fallback'),
      },
      ['source', 'phase', 'kind'],
    ),
    objectSchema({ source: constSchema('direct-ios'), kind: constSchema('not-observed') }, [
      'source',
      'kind',
    ]),
  ],
};

// InteractionEvidence (packages/contracts/src/interaction.ts) — opt-in `--verify` cheap
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

// boot / shutdown share the resolved-device header (packages/contracts/src/device.ts).
const deviceHeaderProperties: Record<string, JsonSchema> = {
  // Public leaf vocabulary (ios | macos | android | linux | web): boot/shutdown
  // emit publicPlatformString, never the internal `apple` platform.
  platform: enumSchema(PUBLIC_PLATFORMS),
  target: enumSchema(DEVICE_TARGETS),
  device: stringSchema('Human-readable device name.'),
  id: stringSchema('Stable device id.'),
  kind: enumSchema(DEVICE_KINDS),
};
const deviceHeaderRequired = ['platform', 'target', 'device', 'id', 'kind'] as const;

// TargetShutdownResult (packages/contracts/src/target-shutdown-contract.ts).
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
 * graft would leak across them, and non-trait entries must stay the SAME
 * object identity their projection tests pin.
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

const tapInteractionResponseDataSchema = interactionResponseDataSchema({
  properties: {
    evidence: interactionEvidenceSchema,
    button: enumSchema(['secondary', 'middle']),
    count: numberSchema('Number of press/click repetitions.'),
    intervalMs: numberSchema('Delay between repeated press/click actions.'),
    holdMs: numberSchema('Hold duration for each action.'),
    jitterPx: numberSchema('Randomization radius in pixels.'),
    doubleTap: booleanSchema('Whether the command requested a double-tap action.'),
  },
});

const fillResponseProperties = {
  text: stringSchema('Text submitted to the field.'),
  delayMs: numberSchema('Delay between typed characters in milliseconds.'),
  evidence: interactionEvidenceSchema,
};

const fillVerificationTargetSchema = objectSchema(
  {
    resourceId: nullableStringSchema('Android resource id of the exact field that changed.'),
    className: nullableStringSchema('Android class name of the exact field that changed.'),
    packageName: nullableStringSchema('Android package name that owns the exact field.'),
    rect: objectSchema(
      {
        x: numberSchema(),
        y: numberSchema(),
        width: numberSchema(),
        height: numberSchema(),
      },
      ['x', 'y', 'width', 'height'],
      'Screen-space rectangle of the exact field that changed.',
    ),
  },
  ['resourceId', 'className', 'packageName', 'rect'],
  'Target identity captured before fill and matched after fill.',
);

const confirmedFillResponseSchema: JsonSchema = {
  ...interactionResponseDataSchema({
    properties: fillResponseProperties,
    required: ['text'],
  }),
  // The public result contract omits verification evidence on an ordinary
  // confirmed fill. Keep this branch disjoint from the unconfirmed branch
  // without making the response strict to unrelated additive fields.
  not: objectSchema({}, ['verification']),
};

const unconfirmedFillResponseSchema = interactionResponseDataSchema({
  properties: {
    ...fillResponseProperties,
    verification: constSchema('unconfirmed'),
    requested: stringSchema('Literal text requested by the fill command.'),
    before: nullableStringSchema('Raw target text captured before the fill.'),
    after: nullableStringSchema('Raw target text captured after the fill.'),
    target: fillVerificationTargetSchema,
  },
  required: ['text', 'verification', 'requested', 'before', 'after', 'target'],
});

const BASE_COMMAND_OUTPUT_SCHEMAS = {
  // buildInteractionResponseData public payloads for interaction commands.
  // #1652: the opt-in `settle` observation is NOT listed here — the trait
  // derivation pass grafts it onto settle-capable entries below.
  press: tapInteractionResponseDataSchema,
  click: tapInteractionResponseDataSchema,
  fill: {
    type: 'object',
    description:
      'Fill response. Android may return target-bound unconfirmed evidence when the exact app-owned field changed but formatting prevented raw equality.',
    oneOf: [confirmedFillResponseSchema, unconfirmedFillResponseSchema],
  },
  longpress: interactionResponseDataSchema({
    properties: {
      durationMs: numberSchema(),
      gesture: constSchema('longpress'),
    },
  }),
  hover: interactionResponseDataSchema({
    properties: {
      gesture: constSchema('hover'),
    },
  }),
  find: objectSchema(
    {
      ref: stringSchema('Snapshot ref without the @ prefix when the find action returns one.'),
      refsGeneration: numberSchema('ADR 0014 ref frame epoch for read-only find actions.'),
      found: booleanSchema('Whether a wait/exists/read-only find satisfied its condition.'),
      waitedMs: numberSchema('Milliseconds waited for a read-only find condition.'),
      text: stringSchema('Text value returned by find get_text.'),
      node: looseObjectSchema('Snapshot node for find get_attrs/get_text.'),
      matches: {
        type: 'array',
        description: 'Every match for the read-only find list action (#1625): { ref, node } each.',
        items: looseObjectSchema('One listed match with its snapshot ref and node.'),
      },
      locator: stringSchema('Locator kind used for the find action.'),
      query: stringSchema('Query argument used for the find action.'),
      x: numberSchema('Resolved x coordinate for mutating find actions.'),
      y: numberSchema('Resolved y coordinate for mutating find actions.'),
      message: stringSchema('Diagnostic message for mutating find actions.'),
      cost: responseCostSchema,
    },
    [],
    'Daemon response data for the find command.',
  ),

  // packages/contracts/src/device.ts
  boot: objectSchema({ ...deviceHeaderProperties, booted: { type: 'boolean', const: true } }, [
    ...deviceHeaderRequired,
    'booted',
  ]),
  shutdown: objectSchema({ ...deviceHeaderProperties, shutdown: targetShutdownResultSchema }, [
    ...deviceHeaderRequired,
    'shutdown',
  ]),

  // packages/contracts/src/viewport.ts
  viewport: objectSchema(
    { width: numberSchema(), height: numberSchema(), message: stringSchema() },
    ['width', 'height', 'message'],
  ),

  // packages/contracts/src/navigation.ts, projected from executable command contracts.
  // The `back` settle observation is grafted by the derivation pass below.
  ...projectedSystemCommandOutputSchemas,

  // packages/contracts/src/wait.ts — compact public daemon projection.
  wait: objectSchema(
    {
      waitedMs: numberSchema(),
      kind: constSchema('selector'),
      text: stringSchema(),
      selector: stringSchema(),
      captures: numberSchema(),
      nodeCount: numberSchema(),
      hint: stringSchema(),
      warning: stringSchema(),
    },
    ['waitedMs'],
  ),

  // packages/contracts/src/scroll-command.ts — ScrollCommandResult. The
  // settle-capable generic-route pair must both be typed so the trait
  // derivation grafts the observation onto each (#1652); platform leaves add
  // gesture-plan coordinates on top, which the non-strict schema admits.
  scroll: objectSchema(
    {
      direction: enumSchema(['up', 'down', 'left', 'right']),
      edge: enumSchema(['top', 'bottom']),
      passes: numberSchema('Edge scrolls only: how many scroll-and-check passes ran.'),
      amount: numberSchema(),
      pixels: numberSchema(),
      durationMs: numberSchema(),
      message: stringSchema(),
    },
    ['direction'],
  ),

  // packages/contracts/src/prepare.ts — prepare is not MCP-exposed, but the schema stays
  // map-complete with CommandResultMap.
  prepare: objectSchema(
    {
      action: constSchema('ios-runner'),
      // PublicPlatform leaf, mirroring PrepareCommandResult (packages/contracts/src/prepare.ts).
      platform: enumSchema(PUBLIC_PLATFORMS),
      deviceId: stringSchema(),
      deviceName: stringSchema(),
      kind: enumSchema(DEVICE_KINDS),
      durationMs: numberSchema(),
      runner: objectSchema({}, []),
      cache: enumSchema(['exact', 'restore-key', 'miss', 'external']),
      artifact: enumSchema(['valid', 'rebuilt']),
      buildMs: numberSchema(),
      connectMs: numberSchema(),
      healthCheckMs: numberSchema(),
      xctestrunPath: stringSchema(),
      recoveryReason: stringSchema(),
      failureReason: stringSchema(),
      timing: objectSchema(
        {
          totalMs: numberSchema(),
          additiveParts: objectSchema(
            {
              buildMs: numberSchema(),
              connectAfterBuildMs: numberSchema(),
              healthCheckMs: numberSchema(),
            },
            ['connectAfterBuildMs', 'healthCheckMs'],
          ),
          containment: objectSchema(
            {
              connectMs: { type: 'array', items: constSchema('buildMs') },
              healthCheckMs: { type: 'array', items: stringSchema() },
            },
            ['healthCheckMs'],
          ),
          note: stringSchema(),
        },
        ['totalMs', 'additiveParts', 'containment', 'note'],
      ),
      message: stringSchema(),
    },
    [
      'action',
      'platform',
      'deviceId',
      'deviceName',
      'kind',
      'durationMs',
      'runner',
      'connectMs',
      'healthCheckMs',
      'timing',
      'message',
    ],
  ),

  // packages/contracts/src/push.ts — discriminated union on public platform.
  push: {
    type: 'object',
    oneOf: [
      objectSchema(
        { platform: constSchema('ios'), bundleId: stringSchema(), message: stringSchema() },
        ['platform', 'bundleId', 'message'],
      ),
      objectSchema(
        {
          platform: constSchema('android'),
          package: stringSchema(),
          action: stringSchema(),
          extrasCount: numberSchema(),
          message: stringSchema(),
        },
        ['platform', 'package', 'action', 'extrasCount', 'message'],
      ),
    ],
  },

  // packages/contracts/src/app-events.ts
  'trigger-app-event': objectSchema(
    {
      event: stringSchema(),
      eventUrl: stringSchema(),
      transport: constSchema('deep-link'),
      message: stringSchema(),
    },
    ['event', 'eventUrl', 'transport', 'message'],
  ),

  // packages/contracts/src/clipboard.ts — discriminated union on `action`.
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

  // packages/contracts/src/app-state.ts — discriminated union on `platform`.
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

  // packages/contracts/src/keyboard.ts — flat closed shape; `platform`/`action` always present.
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

  // packages/contracts/src/doctor.ts
  doctor: objectSchema(
    {
      status: enumSchema(['pass', 'warn', 'fail', 'info']),
      summary: stringSchema(),
      kind: enumSchema(['auto', 'react-native', 'expo', 'repack']),
      platform: stringSchema(),
      target: enumSchema(DEVICE_TARGETS),
      targetApp: stringSchema(),
      metro: objectSchema({ host: stringSchema(), port: numberSchema() }, ['host', 'port']),
      checks: {
        type: 'array',
        items: objectSchema(
          {
            id: stringSchema(),
            status: enumSchema(['pass', 'warn', 'fail', 'info']),
            summary: stringSchema(),
            hint: stringSchema(),
            command: stringSchema(),
            evidence: looseObjectSchema(),
          },
          ['id', 'status', 'summary'],
        ),
      },
    },
    ['status', 'summary', 'kind', 'checks'],
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
      warnings: stringArraySchema,
    },
    ['mode', 'baselineInitialized', 'summary', 'lines'],
  ),

  // packages/contracts/src/replay.ts
  replay: objectSchema(
    {
      replayed: numberSchema(),
      healed: numberSchema(),
      session: stringSchema(),
      sessionActive: booleanSchema(
        'True iff the session is still active — the script had no terminal close.',
      ),
      artifactPaths: stringArraySchema,
      snapshotDiagnostics: looseObjectSchema(),
      message: stringSchema(),
    },
    ['replayed', 'healed', 'session', 'sessionActive', 'artifactPaths', 'message'],
  ),
  test: objectSchema(
    {
      total: numberSchema(),
      executed: numberSchema(),
      passed: numberSchema(),
      failed: numberSchema(),
      skipped: numberSchema(),
      notRun: numberSchema(),
      durationMs: numberSchema(),
      failures: { type: 'array', items: looseObjectSchema() },
      tests: { type: 'array', items: looseObjectSchema() },
      snapshotDiagnostics: looseObjectSchema(),
    },
    [
      'total',
      'executed',
      'passed',
      'failed',
      'skipped',
      'notRun',
      'durationMs',
      'failures',
      'tests',
    ],
  ),

  // packages/contracts/src/recording.ts
  record: {
    type: 'object',
    oneOf: [
      objectSchema(
        {
          recording: constSchema('started'),
          outPath: stringSchema(),
          sessionStateDir: stringSchema(),
          recordingBackend: stringSchema(),
          recordingScope: stringSchema(),
          recordOnlySession: booleanSchema(),
          activeSessionApp: looseObjectSchema(),
          showTouches: booleanSchema(),
        },
        ['recording', 'outPath', 'sessionStateDir', 'showTouches'],
      ),
      objectSchema(
        {
          recording: constSchema('stopped'),
          outPath: stringSchema(),
          telemetryPath: stringSchema(),
          artifacts: { type: 'array', items: artifactSchema },
          recordingBackend: stringSchema(),
          recordingScope: stringSchema(),
          recordOnlySession: booleanSchema(),
          activeSessionApp: looseObjectSchema(),
          durationMs: numberSchema(),
          showTouches: booleanSchema(),
          warning: stringSchema(),
          overlayWarning: stringSchema(),
          chunks: { type: 'array', items: looseObjectSchema() },
        },
        ['recording', 'outPath', 'artifacts', 'durationMs', 'showTouches'],
      ),
    ],
  },
  trace: {
    type: 'object',
    oneOf: [
      objectSchema({ trace: constSchema('started'), outPath: stringSchema() }, [
        'trace',
        'outPath',
      ]),
      objectSchema(
        {
          trace: constSchema('stopped'),
          outPath: stringSchema(),
          artifacts: { type: 'array', items: artifactSchema },
        },
        ['trace', 'outPath', 'artifacts'],
      ),
    ],
  },
} satisfies Record<keyof CommandResultMap, JsonSchema>;

export const COMMAND_OUTPUT_SCHEMAS = deriveSettleObservationSchemas(BASE_COMMAND_OUTPUT_SCHEMAS);
