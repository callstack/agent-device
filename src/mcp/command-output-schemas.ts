import type { JsonSchema } from '../commands/command-contract.ts';
import { projectedSystemCommandOutputSchemas } from '../commands/system/index.ts';
import type { CommandResultMap } from '../core/command-descriptor/command-result.ts';
import { booleanSchema, looseObjectSchema, stringSchema } from '../commands/command-input.ts';
import { SESSION_SURFACES } from '../contracts/session-surface.ts';
import { DEVICE_TARGETS, PUBLIC_PLATFORMS } from '../kernel/device.ts';

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

// ResolutionDiagnosticEntry (src/contracts/interaction.ts) — a disambiguation
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

// ResolutionDisclosure (src/contracts/interaction.ts) — never ref-issuing;
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
          ['visible', 'deepest', 'smallest-area'],
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

// boot / shutdown share the resolved-device header (src/contracts/device.ts).
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

const tapInteractionResponseDataSchema = interactionResponseDataSchema({
  properties: {
    evidence: interactionEvidenceSchema,
    settle: settleObservationSchema,
    button: enumSchema(['secondary', 'middle']),
    count: numberSchema('Number of press/click repetitions.'),
    intervalMs: numberSchema('Delay between repeated press/click actions.'),
    holdMs: numberSchema('Hold duration for each action.'),
    jitterPx: numberSchema('Randomization radius in pixels.'),
    doubleTap: booleanSchema('Whether the command requested a double-tap action.'),
  },
});

export const COMMAND_OUTPUT_SCHEMAS = {
  // buildInteractionResponseData public payloads for interaction commands.
  press: tapInteractionResponseDataSchema,
  click: tapInteractionResponseDataSchema,
  fill: interactionResponseDataSchema({
    properties: {
      text: stringSchema('Text submitted to the field.'),
      delayMs: numberSchema('Delay between typed characters in milliseconds.'),
      evidence: interactionEvidenceSchema,
      settle: settleObservationSchema,
    },
    required: ['text'],
  }),
  longpress: interactionResponseDataSchema({
    properties: {
      durationMs: numberSchema(),
      settle: settleObservationSchema,
      gesture: constSchema('longpress'),
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
      locator: stringSchema('Locator kind used for the find action.'),
      query: stringSchema('Query argument used for the find action.'),
      x: numberSchema('Resolved x coordinate for mutating find actions.'),
      y: numberSchema('Resolved y coordinate for mutating find actions.'),
      message: stringSchema('Diagnostic message for mutating find actions.'),
      settle: settleObservationSchema,
      cost: responseCostSchema,
    },
    [],
    'Daemon response data for the find command.',
  ),

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

  // src/contracts/navigation.ts, projected from executable command contracts.
  ...projectedSystemCommandOutputSchemas,

  // src/contracts/wait.ts — compact public daemon projection.
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

  // src/contracts/prepare.ts — prepare is not MCP-exposed, but the schema stays
  // map-complete with CommandResultMap.
  prepare: objectSchema(
    {
      action: constSchema('ios-runner'),
      // PublicPlatform leaf, mirroring PrepareCommandResult (src/contracts/prepare.ts).
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

  // src/contracts/push.ts — discriminated union on public platform.
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

  // src/contracts/app-events.ts
  'trigger-app-event': objectSchema(
    {
      event: stringSchema(),
      eventUrl: stringSchema(),
      transport: constSchema('deep-link'),
      message: stringSchema(),
    },
    ['event', 'eventUrl', 'transport', 'message'],
  ),

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

  // src/contracts/doctor.ts
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

  // src/contracts/diff.ts — the public Node command accepts snapshot diffs.
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

  // src/contracts/replay.ts
  replay: objectSchema(
    {
      replayed: numberSchema(),
      healed: numberSchema(),
      session: stringSchema(),
      artifactPaths: stringArraySchema,
      snapshotDiagnostics: looseObjectSchema(),
      message: stringSchema(),
    },
    ['replayed', 'healed', 'session', 'artifactPaths', 'message'],
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

  // src/contracts/recording.ts
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
      objectSchema({ trace: constSchema('stopped'), outPath: stringSchema() }, [
        'trace',
        'outPath',
      ]),
    ],
  },
} satisfies Record<keyof CommandResultMap, JsonSchema>;
