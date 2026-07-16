import type {
  ClickOptions,
  FindOptions,
  FillOptions,
  FlingOptions,
  FocusOptions,
  GetOptions,
  PanOptions,
  PinchOptions,
  PressOptions,
  IsOptions,
  LongPressOptions,
  RotateGestureOptions,
  ScrollOptions,
  SwipeGestureOptions,
  SwipeOptions,
  TransformGestureOptions,
  TypeTextOptions,
} from '../../client/client-types.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import {
  REPEATED_TOUCH_FLAGS,
  SELECTOR_SNAPSHOT_FLAGS,
  SETTLE_FLAGS,
} from '../cli-grammar/flag-groups.ts';
import { type FlagKey } from '../cli-grammar/flag-types.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  commonToClientOptions,
  toClientElementTarget,
  toClientInteractionTarget,
  toRepeatedOptions,
  toSelectorSnapshotOptions,
} from '../command-input.ts';
import {
  interactionCommandMetadata,
  type ClickInput,
  type FillInput,
  type FlingInput,
  type GetInput,
  type LongPressInput,
  type PanInput,
  type PinchInput,
  type PressInput,
  type RotateInput,
  type SwipeGestureInput,
  type TransformInput,
} from './metadata.ts';
import { gestureCliReaders, gestureDaemonWriters } from './gesture.ts';
import { interactionCliReaders, interactionDaemonWriters } from './interactions.ts';
import { interactionCliOutputFormatters } from './output.ts';
import { selectorCliReaders, selectorDaemonWriters } from './selectors.ts';

const interactionCliSchemas = {
  get: {
    usageOverride: 'get text|attrs <@ref|selector>',
    positionalArgs: ['subcommand', 'target'],
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS, 'record'],
  },
  find: {
    usageOverride: 'find <locator|text> <action> [value] [--first|--last]',
    helpDescription: 'Find by text/label/value/role/id and run action',
    summary: 'Find an element and act',
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
    helpDescription:
      'Short press a semantic UI target by ref, selector, or point. For native context menus or hold gestures, use longpress <target> <durationMs> instead of press --hold-ms.',
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
    helpDescription:
      'Open native context menus or long-press targets by ref, selector, or point. Duration is positional, for example longpress @e12 800 or longpress 300 500 800.',
    positionalArgs: ['targetOrX', 'yOrDurationMs?', 'durationMs?'],
    allowsExtraPositionals: true,
    allowedFlags: [...postActionObservationCliFlags('longpress'), ...SELECTOR_SNAPSHOT_FLAGS],
  },
  swipe: {
    helpDescription:
      'Quick coordinate fling with optional repeat pattern. The historical duration positional is accepted as a deprecated alias to pan.',
    positionalArgs: ['x1', 'y1', 'x2', 'y2', 'durationMs?'],
    allowedFlags: ['count', 'pauseMs', 'pattern'],
  },
  gesture: {
    usageOverride: 'gesture <pan|fling|swipe|pinch|rotate|transform> ...',
    listUsageOverride: 'gesture <pan|fling|swipe|pinch|rotate|transform> ...',
    helpDescription:
      'Run touch gestures: pan <x> <y> <dx> <dy> [durationMs], fling <up|down|left|right> <x> <y> [distance], swipe <left|right|left-edge|right-edge>, pinch <scale> [x] [y], rotate <degrees> [x] [y], or transform <x> <y> <dx> <dy> <scale> <degrees> [durationMs]. Historical swipe/fling duration and rotate velocity arguments remain deprecated compatibility aliases. For command plans, output only command lines. Android transform verification should use all app-observable effects, for example wait text "pan changed yes", wait text "pinch changed yes", and wait text "rotate changed yes", not exact transform values.',
    summary: 'Run pan, fling, swipe, pinch, rotate, or transform gestures',
    positionalArgs: ['pan|fling|swipe|pinch|rotate|transform', 'args?'],
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
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS, 'delayMs', ...postActionObservationCliFlags('fill')],
  },
  scroll: {
    usageOverride: 'scroll <direction|top|bottom> [amount] [--pixels <n>] [--duration-ms <ms>]',
    helpDescription: 'Scroll in a direction, or toward the top/bottom edge of scrollable content.',
    summary: 'Scroll in a direction or to an edge',
    positionalArgs: ['directionOrEdge', 'amount?'],
    allowedFlags: ['pixels', 'durationMs'],
  },
} as const satisfies Record<string, CommandSchemaOverride>;

type InteractionCommandMetadata = (typeof interactionCommandMetadata)[number];
type InteractionCommandName = InteractionCommandMetadata['name'];
function postActionObservationCliFlags(command: InteractionCommandName): readonly FlagKey[] {
  const flags: FlagKey[] = [];
  if (commandSupportsVerifyEvidence(command)) flags.push('verify');
  if (commandSupportsSettleObservation(command)) flags.push(...SETTLE_FLAGS);
  return flags;
}

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
    }
  },
);

const clickCommandFacet = defineCommandFacet({
  name: 'click',
  metadata: metadata('click'),
  definition: clickCommandDefinition,
  cliSchema: interactionCliSchemas.click,
  cliReader: interactionCliReaders.click,
  daemonWriter: interactionDaemonWriters.click,
  cliOutputFormatter: interactionCliOutputFormatters.click,
});

const pressCommandFacet = defineCommandFacet({
  name: 'press',
  metadata: metadata('press'),
  definition: pressCommandDefinition,
  cliSchema: interactionCliSchemas.press,
  cliReader: interactionCliReaders.press,
  daemonWriter: interactionDaemonWriters.press,
  cliOutputFormatter: interactionCliOutputFormatters.press,
});

const fillCommandFacet = defineCommandFacet({
  name: 'fill',
  metadata: metadata('fill'),
  definition: fillCommandDefinition,
  cliSchema: interactionCliSchemas.fill,
  cliReader: interactionCliReaders.fill,
  daemonWriter: interactionDaemonWriters.fill,
  cliOutputFormatter: interactionCliOutputFormatters.fill,
});

const longPressCommandFacet = defineCommandFacet({
  name: 'longpress',
  metadata: metadata('longpress'),
  definition: longPressCommandDefinition,
  cliSchema: interactionCliSchemas.longpress,
  cliReader: interactionCliReaders.longpress,
  daemonWriter: interactionDaemonWriters.longpress,
  cliOutputFormatter: interactionCliOutputFormatters.longpress,
});

const swipeCommandFacet = defineCommandFacet({
  name: 'swipe',
  metadata: metadata('swipe'),
  definition: swipeCommandDefinition,
  cliSchema: interactionCliSchemas.swipe,
  cliReader: interactionCliReaders.swipe,
  daemonWriter: interactionDaemonWriters.swipe,
});

const focusCommandFacet = defineCommandFacet({
  name: 'focus',
  metadata: metadata('focus'),
  definition: focusCommandDefinition,
  cliSchema: interactionCliSchemas.focus,
  cliReader: interactionCliReaders.focus,
  daemonWriter: interactionDaemonWriters.focus,
});

const typeCommandFacet = defineCommandFacet({
  name: 'type',
  metadata: metadata('type'),
  definition: typeCommandDefinition,
  cliSchema: interactionCliSchemas.type,
  cliReader: interactionCliReaders.type,
  daemonWriter: interactionDaemonWriters.type,
});

const scrollCommandFacet = defineCommandFacet({
  name: 'scroll',
  metadata: metadata('scroll'),
  definition: scrollCommandDefinition,
  cliSchema: interactionCliSchemas.scroll,
  cliReader: interactionCliReaders.scroll,
  daemonWriter: interactionDaemonWriters.scroll,
});

const getCommandFacet = defineCommandFacet({
  name: 'get',
  metadata: metadata('get'),
  definition: getCommandDefinition,
  cliSchema: interactionCliSchemas.get,
  cliReader: interactionCliReaders.get,
  daemonWriter: interactionDaemonWriters.get,
  cliOutputFormatter: interactionCliOutputFormatters.get,
});

const isCommandFacet = defineCommandFacet({
  name: 'is',
  metadata: metadata('is'),
  definition: isCommandDefinition,
  cliSchema: interactionCliSchemas.is,
  cliReader: selectorCliReaders.is,
  daemonWriter: selectorDaemonWriters.is,
  cliOutputFormatter: interactionCliOutputFormatters.is,
});

const findCommandFacet = defineCommandFacet({
  name: 'find',
  metadata: metadata('find'),
  definition: findCommandDefinition,
  cliSchema: interactionCliSchemas.find,
  cliReader: selectorCliReaders.find,
  daemonWriter: selectorDaemonWriters.find,
  cliOutputFormatter: interactionCliOutputFormatters.find,
});

const gestureCommandFacet = defineCommandFacet({
  name: 'gesture',
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

function toFlingOptions(input: FlingInput): FlingOptions {
  return {
    ...commonToClientOptions(input),
    direction: input.direction,
    x: input.origin.x,
    y: input.origin.y,
    distance: input.distance,
    durationMs: input.durationMs,
  };
}

function toSwipeGestureOptions(input: SwipeGestureInput): SwipeGestureOptions {
  return {
    ...commonToClientOptions(input),
    preset: input.preset,
    durationMs: input.durationMs,
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
    velocity: input.velocity,
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
