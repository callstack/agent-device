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
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { REPEATED_TOUCH_FLAGS, SELECTOR_SNAPSHOT_FLAGS } from '../cli-grammar/flag-groups.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { postActionObservationCliFlags } from '../post-action-observation-grammar.ts';
import {
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

const interactionCliSchemas = {
  get: {
    usageOverride: 'get text|attrs <@ref|selector>',
    positionalArgs: ['subcommand', 'target'],
    allowsExtraPositionals: true,
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS, 'record'],
  },
  find: {
    usageOverride: 'find <locator|text> <action> [value] [--first|--last]',
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
    positionalArgs: ['targetOrX', 'yOrDurationMs?', 'durationMs?'],
    allowsExtraPositionals: true,
    allowedFlags: [...postActionObservationCliFlags('longpress'), ...SELECTOR_SNAPSHOT_FLAGS],
  },
  hover: {
    usageOverride: 'hover <x y|@ref|selector>',
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
    usageOverride:
      'scroll <direction|top|bottom> [amount] [--pixels <n>] [--duration-ms <ms>] [--settle]',
    positionalArgs: ['directionOrEdge', 'amount?'],
    allowedFlags: ['pixels', 'durationMs', ...postActionObservationCliFlags('scroll')],
  },
} as const satisfies Record<string, CommandSchemaOverride>;

type InteractionCommandMetadata = (typeof interactionCommandMetadata)[number];
type InteractionCommandName = InteractionCommandMetadata['name'];

const clickCommandDefinition = defineExecutableCommand(metadata('click'), (client, input) =>
  client.interactions.click(toClickOptions(input)),
);

const pressCommandDefinition = defineExecutableCommand(metadata('press'), (client, input) =>
  client.interactions.press(toPressOptions(input)),
);

const fillCommandDefinition = defineExecutableCommand(metadata('fill'), (client, input) =>
  client.interactions.fill(toFillOptions(input)),
);

const longPressCommandDefinition = defineExecutableCommand(metadata('longpress'), (client, input) =>
  client.interactions.longPress(toLongPressOptions(input)),
);

const hoverCommandDefinition = defineExecutableCommand(metadata('hover'), (client, input) =>
  client.interactions.hover(toHoverOptions(input)),
);

const swipeCommandDefinition = defineExecutableCommand(metadata('swipe'), (client, input) =>
  client.interactions.swipe(input as SwipeOptions),
);

const focusCommandDefinition = defineExecutableCommand(metadata('focus'), (client, input) =>
  client.interactions.focus(input as FocusOptions),
);

const typeCommandDefinition = defineExecutableCommand(metadata('type'), (client, input) =>
  client.interactions.type(input as TypeTextOptions),
);

const scrollCommandDefinition = defineExecutableCommand(metadata('scroll'), (client, input) =>
  client.interactions.scroll(input as ScrollOptions),
);

const getCommandDefinition = defineExecutableCommand(metadata('get'), (client, input) =>
  client.interactions.get(toGetOptions(input)),
);

const isCommandDefinition = defineExecutableCommand(metadata('is'), (client, input) =>
  client.interactions.is(input as IsOptions),
);

const findCommandDefinition = defineExecutableCommand(metadata('find'), (client, input) =>
  client.interactions.find(input as FindOptions),
);

const gestureCommandDefinition = defineExecutableCommand(
  metadata('gesture'),
  async (client, input) => {
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
);

const clickCommandFacet = defineCommandFacet({
  name: 'click',
  text: {
    summary: 'Click or tap a UI target',
  },
  metadata: metadata('click'),
  definition: clickCommandDefinition,
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
  definition: pressCommandDefinition,
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
  definition: fillCommandDefinition,
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
  definition: longPressCommandDefinition,
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
  definition: hoverCommandDefinition,
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
  definition: swipeCommandDefinition,
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
  definition: focusCommandDefinition,
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
  definition: typeCommandDefinition,
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
  definition: scrollCommandDefinition,
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
  definition: getCommandDefinition,
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
  definition: isCommandDefinition,
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
  definition: findCommandDefinition,
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
  definition: gestureCommandDefinition,
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
