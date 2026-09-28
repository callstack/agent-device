import type {
  ClickOptions,
  DragOptions,
  FillOptions,
  FindOptions,
  FlingOptions,
  FocusOptions,
  GetOptions,
  HoverOptions,
  IsOptions,
  LongPressOptions,
  PanOptions,
  PinchOptions,
  PressOptions,
  RotateGestureOptions,
  ScrollOptions,
  SwipeGestureOptions,
  SwipeOptions,
  TransformGestureOptions,
  TypeTextOptions,
} from '@agent-device/contracts/client';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import {
  REPEATED_TOUCH_FLAGS,
  SELECTOR_SNAPSHOT_FLAGS,
} from '@agent-device/command-registry/flag-groups';
import { postActionObservationCliFlags } from '../post-action-observation-grammar.ts';
import type { JsonSchema } from '../command-contract.ts';
import {
  booleanSchema,
  constSchema,
  enumSchema,
  looseObjectSchema,
  nullableStringSchema,
  numberSchema,
  objectSchema,
  stringArraySchema,
  stringSchema,
  toClientElementTarget,
  toClientInteractionTarget,
  toRepeatedOptions,
  toSelectorSnapshotOptions,
} from '../command-input.ts';
import { commonToClientOptions } from '../common-input-fields.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { gestureCliReaders, gestureDaemonWriters } from './gesture.ts';
import { interactionCliReaders, interactionDaemonWriters } from './interactions.ts';
import {
  interactionCommandMetadata,
  type ClickInput,
  type DragInput,
  type FillInput,
  type FlingInput,
  type GetInput,
  type HoverInput,
  type LongPressInput,
  type PanInput,
  type PinchInput,
  type PressInput,
  type RotateInput,
  type SwipeGestureInput,
  type TransformInput,
} from './metadata.ts';
import { interactionCliOutputFormatters } from './output.ts';
import { selectorCliReaders, selectorDaemonWriters } from './selectors.ts';

// PostActionSurfaceChange (packages/contracts/src/interaction.ts) — the post-action capture
// describes a different surface than the pre-action baseline (#2438), so no same-surface
// comparison is presented across it.
export const postActionSurfaceChangeSchema: JsonSchema = objectSchema(
  {
    from: stringSchema('Surface the pre-action baseline described: a host bundle id, or app.'),
    to: stringSchema('Surface the post-action capture describes: a host bundle id, or app.'),
    disclosure: stringSchema('Agent-facing sentence explaining the surface transition.'),
  },
  ['from', 'to', 'disclosure'],
  'Present when an in-place system surface (web sign-in or Apple Pay sheet) was presented over the app, or left it.',
);

// InteractionEvidence (packages/contracts/src/interaction.ts) — opt-in `--verify` cheap
// post-condition evidence (#1047).
const interactionEvidenceSchema: JsonSchema = objectSchema(
  {
    foregroundApp: stringSchema('Foreground app bundle id or name, when the capture carries it.'),
    nodeCount: numberSchema('Node count in the post-action interactive-only capture.'),
    interactiveNodeCount: numberSchema('Subset of nodeCount the platform reports as hittable.'),
    digest: stringSchema('Order-independent digest of the post-action node multiset.'),
    changedFromBefore: booleanSchema(
      'Whether the post-action digest differs from the pre-action capture digest. false is evidence, not failure. With surfaceChange present, no digest comparison is made: it reports that surface transition.',
    ),
    surfaceChange: postActionSurfaceChangeSchema,
  },
  ['nodeCount', 'interactiveNodeCount', 'digest', 'changedFromBefore'],
);

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
      selectorChain: stringArraySchema(),
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

/**
 * This family's advertised MCP `outputSchema`s, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields such as `settle`/`cost` keep
 * validating. #1652: the opt-in `settle` observation is NOT listed here — the trait derivation
 * pass in that file grafts it onto settle-capable entries.
 */
export const INTERACTION_COMMAND_OUTPUT_SCHEMAS = {
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
} satisfies Pick<
  Record<keyof CommandResultMap, JsonSchema>,
  'press' | 'click' | 'fill' | 'longpress' | 'hover' | 'find'
>;

const interactionCliSchemas = {
  get: {
    usageOverride: 'get text|attrs <@ref|selector>',
    usageFlags: [],
    positionalArgs: ['subcommand', 'target'],
    allowsExtraPositionals: true,
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS, 'record'],
  },
  find: {
    usageOverride: 'find <locator|text> <action> [value] [--first|--last]',
    usageFlags: [],
    positionalArgs: ['query', 'action', 'value?'],
    allowsExtraPositionals: true,
    allowedFlags: ['snapshotDepth', 'snapshotRaw', 'findFirst', 'findLast', 'record'],
  },
  is: {
    positionalArgs: ['predicate', 'selector', 'value?'],
    allowsExtraPositionals: true,
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS, 'record'],
  },
  click: {
    usageOverride: 'click <x y|@ref|selector>',
    usageFlags: [],
    positionalArgs: ['target'],
    allowsExtraPositionals: true,
    allowedFlags: [
      ...REPEATED_TOUCH_FLAGS,
      'clickButton',
      ...postActionObservationCliFlags('click'),
      ...SELECTOR_SNAPSHOT_FLAGS,
    ],
  },
  press: {
    usageOverride: 'press <x y|@ref|selector>',
    usageFlags: [],
    positionalArgs: ['targetOrX', 'y?'],
    allowsExtraPositionals: true,
    allowedFlags: [
      ...REPEATED_TOUCH_FLAGS,
      ...postActionObservationCliFlags('press'),
      ...SELECTOR_SNAPSHOT_FLAGS,
    ],
  },
  longpress: {
    usageOverride: 'longpress <x y|@ref|selector> [durationMs]',
    usageFlags: [],
    positionalArgs: ['targetOrX', 'yOrDurationMs?', 'durationMs?'],
    allowsExtraPositionals: true,
    allowedFlags: [...postActionObservationCliFlags('longpress'), ...SELECTOR_SNAPSHOT_FLAGS],
  },
  hover: {
    usageOverride: 'hover <x y|@ref|selector>',
    usageFlags: [],
    positionalArgs: ['targetOrX', 'y?'],
    allowsExtraPositionals: true,
    allowedFlags: [...postActionObservationCliFlags('hover'), ...SELECTOR_SNAPSHOT_FLAGS],
  },
  swipe: {
    positionalArgs: ['x1', 'y1', 'x2', 'y2'],
    // Arity is enforced by swipePayloadFromPositionals (assertGestureArity), so
    // an extra positional reaches that migration-hint error, not this schema's.
    allowsExtraPositionals: true,
    allowedFlags: ['count', 'pauseMs', 'pattern'],
  },
  gesture: {
    usageOverride: 'gesture <pan|fling|swipe|pinch|rotate|transform|drag> ...',
    usageFlags: [],
    listUsageOverride: 'gesture <pan|fling|swipe|pinch|rotate|transform|drag> ...',
    positionalArgs: ['pan|fling|swipe|pinch|rotate|transform|drag', 'args?'],
    allowsExtraPositionals: true,
    allowedFlags: ['pointerCount'],
  },
  focus: {
    positionalArgs: ['x', 'y'],
  },
  type: {
    positionalArgs: ['text'],
    allowsExtraPositionals: true,
    allowedFlags: ['delayMs'],
  },
  fill: {
    usageOverride: 'fill <x> <y> <text> | fill <@ref|selector> <text>',
    usageFlags: [],
    positionalArgs: ['targetOrX', 'yOrText', 'text?'],
    allowsExtraPositionals: true,
    allowedFlags: [
      ...SELECTOR_SNAPSHOT_FLAGS,
      'delayMs',
      'recordAs',
      ...postActionObservationCliFlags('fill'),
    ],
  },
  scroll: {
    usageOverride: 'scroll <direction|top|bottom> [amount]',
    usageFlags: ['until', 'pixels', 'durationMs', 'settle'],
    positionalArgs: ['directionOrEdge', 'amount?'],
    allowedFlags: ['pixels', 'durationMs', 'until', ...postActionObservationCliFlags('scroll')],
  },
} as const satisfies Record<string, CommandSchemaOverride>;

type InteractionCommandMetadata = (typeof interactionCommandMetadata)[number];
type InteractionCommandName = InteractionCommandMetadata['name'];

const clickCommandFacet = defineCommandFacet({
  name: 'click',
  text: {
    summary: 'Click or tap a UI target',
  },
  metadata: metadata('click'),
  run: (client, input) => client.interactions.click(toClickOptions(input)),
  cliSchema: interactionCliSchemas.click,
  cliReader: interactionCliReaders.click,
  daemonWriter: interactionDaemonWriters.click,
  cliOutputFormatter: interactionCliOutputFormatters.click,
});

const pressCommandFacet = defineCommandFacet({
  name: 'press',
  text: {
    summary: 'Short-press a UI target',
    cliDetail: 'The hold duration is positional on longpress, not press --hold-ms.',
  },
  metadata: metadata('press'),
  run: (client, input) => client.interactions.press(toPressOptions(input)),
  cliSchema: interactionCliSchemas.press,
  cliReader: interactionCliReaders.press,
  daemonWriter: interactionDaemonWriters.press,
  cliOutputFormatter: interactionCliOutputFormatters.press,
});

const fillCommandFacet = defineCommandFacet({
  name: 'fill',
  text: {
    summary: 'Replace text in a UI input',
    cliDetail:
      'Every positional after an @ref is the replacement text, so fill @e57 good morning enters "good morning"; quote the text when the shell must preserve exact whitespace. Clear a field with an empty text argument: fill @e57 "" (the argument must be present — fill @e57 alone is a missing argument, not a clear). When visible label text also matches a non-input element, constrain the target with editable=true, for example fill \'label="Email" editable=true\' "qa@example.com".',
  },
  metadata: metadata('fill'),
  run: (client, input) => client.interactions.fill(toFillOptions(input)),
  cliSchema: interactionCliSchemas.fill,
  cliReader: interactionCliReaders.fill,
  daemonWriter: interactionDaemonWriters.fill,
  cliOutputFormatter: interactionCliOutputFormatters.fill,
});

const longPressCommandFacet = defineCommandFacet({
  name: 'longpress',
  text: {
    summary: 'Hold a UI target to open a context menu',
    cliDetail: 'Duration is positional, for example longpress @e12 800 or longpress 300 500 800.',
  },
  metadata: metadata('longpress'),
  run: (client, input) => client.interactions.longPress(toLongPressOptions(input)),
  cliSchema: interactionCliSchemas.longpress,
  cliReader: interactionCliReaders.longpress,
  daemonWriter: interactionDaemonWriters.longpress,
  cliOutputFormatter: interactionCliOutputFormatters.longpress,
});

const hoverCommandFacet = defineCommandFacet({
  name: 'hover',
  text: {
    summary: 'Hover the pointer over a UI target (web only)',
    cliDetail:
      'The pointer stays where hover left it: read the revealed UI (--settle or snapshot -i) and act on it before another click or hover moves the pointer away.',
  },
  metadata: metadata('hover'),
  run: (client, input) => client.interactions.hover(toHoverOptions(input)),
  cliSchema: interactionCliSchemas.hover,
  cliReader: interactionCliReaders.hover,
  daemonWriter: interactionDaemonWriters.hover,
  cliOutputFormatter: interactionCliOutputFormatters.hover,
});

const swipeCommandFacet = defineCommandFacet({
  name: 'swipe',
  text: {
    summary: 'Fling between coordinates',
  },
  metadata: metadata('swipe'),
  run: (client, input) => client.interactions.swipe(input as SwipeOptions),
  cliSchema: interactionCliSchemas.swipe,
  cliReader: interactionCliReaders.swipe,
  daemonWriter: interactionDaemonWriters.swipe,
});

const focusCommandFacet = defineCommandFacet({
  name: 'focus',
  text: {
    summary: 'Focus input at screen coordinates',
  },
  metadata: metadata('focus'),
  run: (client, input) => client.interactions.focus(input as FocusOptions),
  cliSchema: interactionCliSchemas.focus,
  cliReader: interactionCliReaders.focus,
  daemonWriter: interactionDaemonWriters.focus,
});

const typeCommandFacet = defineCommandFacet({
  name: 'type',
  text: {
    summary: 'Append text to the focused input',
  },
  metadata: metadata('type'),
  run: (client, input) => client.interactions.type(input as TypeTextOptions),
  cliSchema: interactionCliSchemas.type,
  cliReader: interactionCliReaders.type,
  daemonWriter: interactionDaemonWriters.type,
});

const scrollCommandFacet = defineCommandFacet({
  name: 'scroll',
  text: {
    summary: 'Scroll in a direction or to an edge',
  },
  metadata: metadata('scroll'),
  run: (client, input) => client.interactions.scroll(input as ScrollOptions),
  cliSchema: interactionCliSchemas.scroll,
  cliReader: interactionCliReaders.scroll,
  daemonWriter: interactionDaemonWriters.scroll,
  cliOutputFormatter: interactionCliOutputFormatters.scroll,
});

const getCommandFacet = defineCommandFacet({
  name: 'get',
  text: {
    summary: 'Read element text or attributes',
  },
  metadata: metadata('get'),
  run: (client, input) => client.interactions.get(toGetOptions(input)),
  cliSchema: interactionCliSchemas.get,
  cliReader: interactionCliReaders.get,
  daemonWriter: interactionDaemonWriters.get,
  cliOutputFormatter: interactionCliOutputFormatters.get,
});

const isCommandFacet = defineCommandFacet({
  name: 'is',
  text: {
    summary: 'Check a UI predicate on a selector',
  },
  metadata: metadata('is'),
  run: (client, input) => client.interactions.is(input as IsOptions),
  cliSchema: interactionCliSchemas.is,
  cliReader: selectorCliReaders.is,
  daemonWriter: selectorDaemonWriters.is,
  cliOutputFormatter: interactionCliOutputFormatters.is,
});

const findCommandFacet = defineCommandFacet({
  name: 'find',
  text: {
    summary: 'Find an element and act',
  },
  metadata: metadata('find'),
  run: (client, input) => client.interactions.find(input as FindOptions),
  cliSchema: interactionCliSchemas.find,
  cliReader: selectorCliReaders.find,
  daemonWriter: selectorDaemonWriters.find,
  cliOutputFormatter: interactionCliOutputFormatters.find,
});

const gestureCommandFacet = defineCommandFacet({
  name: 'gesture',
  text: {
    summary: 'Run pan, fling, swipe, pinch, rotate, transform, or drag gestures',
    cliDetail:
      'Argument shapes: pan <x> <y> <dx> <dy> [durationMs], fling <up|down|left|right> <x> <y> [distance], swipe <left|right|left-edge|right-edge>, pinch <scale> [x] [y], rotate <degrees> [x] [y], transform <x> <y> <dx> <dy> <scale> <degrees> [durationMs], or drag <source-selector|pinned-ref> <destination-selector|pinned-ref> [sourceHoldMs] [moveMs] [destinationHoldMs]. For command plans, output only command lines. Android transform verification should use all app-observable effects, for example wait text "pan changed yes", wait text "pinch changed yes", and wait text "rotate changed yes", not exact transform values.',
  },
  metadata: metadata('gesture'),
  run: async (client, input) => {
    switch (input.kind) {
      case 'pan':
        return await client.interactions.pan(toPanOptions(input));
      case 'fling':
        return await client.interactions.fling(toFlingOptions(input));
      case 'swipe':
        return await client.interactions.swipeGesture(toSwipeGestureOptions(input));
      case 'pinch':
        return await client.interactions.pinch(toPinchOptions(input));
      case 'rotate':
        return await client.interactions.rotateGesture(toRotateOptions(input));
      case 'transform':
        return await client.interactions.transformGesture(toTransformOptions(input));
      case 'drag':
        return await client.interactions.drag(toDragOptions(input));
    }
  },
  cliSchema: interactionCliSchemas.gesture,
  cliReader: gestureCliReaders.gesture,
  daemonWriter: gestureDaemonWriters.gesture,
});

export const interactionCommandFamily = defineCommandFamilyFromFacets({
  name: 'interaction',
  clientSurface: false,
  commands: [
    clickCommandFacet,
    pressCommandFacet,
    fillCommandFacet,
    longPressCommandFacet,
    hoverCommandFacet,
    swipeCommandFacet,
    focusCommandFacet,
    typeCommandFacet,
    scrollCommandFacet,
    getCommandFacet,
    isCommandFacet,
    findCommandFacet,
    gestureCommandFacet,
  ],
});

function metadata<TName extends InteractionCommandName>(
  name: TName,
): Extract<InteractionCommandMetadata, { name: TName }> {
  const definition = interactionCommandMetadata.find((item) => item.name === name);
  if (!definition) throw new Error(`Missing interaction command metadata for ${name}`);
  return definition as Extract<InteractionCommandMetadata, { name: TName }>;
}

function toClickOptions(input: ClickInput): ClickOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    ...toRepeatedOptions(input),
    button: input.button,
    verify: input.verify,
    ...toSettleOptions(input),
  };
}

function toPressOptions(input: PressInput): PressOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    ...toRepeatedOptions(input),
    verify: input.verify,
    ...toSettleOptions(input),
  };
}

function toFillOptions(input: FillInput): FillOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    text: input.text,
    delayMs: input.delayMs,
    recordAs: input.recordAs,
    verify: input.verify,
    ...toSettleOptions(input),
  };
}

function toLongPressOptions(input: LongPressInput): LongPressOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    durationMs: input.durationMs,
    ...toSettleOptions(input),
  };
}

function toHoverOptions(input: HoverInput): HoverOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    ...toSettleOptions(input),
  };
}

function toSettleOptions(input: {
  settle?: boolean;
  settleQuietMs?: number;
  timeoutMs?: number;
}): Pick<PressOptions, 'settle' | 'settleQuietMs' | 'timeoutMs'> {
  return {
    settle: input.settle,
    settleQuietMs: input.settleQuietMs,
    timeoutMs: input.timeoutMs,
  };
}

function toGetOptions(input: GetInput): GetOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientElementTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    format: input.format,
    // `--record` is scoped (ADR 0012 decision 6 amendment), so it does NOT ride
    // the common seam and each observation-capable projection forwards it
    // explicitly. `is`/`find`/`snapshot` pass their whole input through, so
    // `get` — the one that rebuilds its options object — is the only place this
    // is needed. Without it `get --record` parses, reaches the reader, survives
    // `readInput`, and is then dropped here (#1303 regression, same re-projection
    // cause as the `--no-record` gap this change fixes).
    record: input.record,
  };
}

function toPanOptions(input: PanInput): PanOptions {
  return {
    ...commonToClientOptions(input),
    x: input.origin.x,
    y: input.origin.y,
    dx: input.delta.x,
    dy: input.delta.y,
    pointerCount: input.pointerCount,
    durationMs: input.durationMs,
  };
}

function toDragOptions(input: DragInput): DragOptions {
  return {
    ...commonToClientOptions(input),
    source: input.source,
    destination: input.destination,
    sourceHoldMs: input.sourceHoldMs,
    moveMs: input.moveMs,
    destinationHoldMs: input.destinationHoldMs,
  };
}

function toFlingOptions(input: FlingInput): FlingOptions {
  return {
    ...commonToClientOptions(input),
    direction: input.direction,
    x: input.origin.x,
    y: input.origin.y,
    distance: input.distance,
  };
}

function toSwipeGestureOptions(input: SwipeGestureInput): SwipeGestureOptions {
  return {
    ...commonToClientOptions(input),
    preset: input.preset,
  };
}

function toPinchOptions(input: PinchInput): PinchOptions {
  return {
    ...commonToClientOptions(input),
    scale: input.scale,
    x: input.origin?.x,
    y: input.origin?.y,
  };
}

function toRotateOptions(input: RotateInput): RotateGestureOptions {
  return {
    ...commonToClientOptions(input),
    degrees: input.degrees,
    x: input.origin?.x,
    y: input.origin?.y,
  };
}

function toTransformOptions(input: TransformInput): TransformGestureOptions {
  return {
    ...commonToClientOptions(input),
    x: input.origin.x,
    y: input.origin.y,
    dx: input.delta.x,
    dy: input.delta.y,
    scale: input.scale,
    degrees: input.degrees,
    durationMs: input.durationMs,
  };
}
