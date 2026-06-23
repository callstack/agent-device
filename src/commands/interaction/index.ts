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
} from '../../client-types.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { REPEATED_TOUCH_FLAGS, SELECTOR_SNAPSHOT_FLAGS } from '../../utils/cli-flags.ts';
import { defineCommandFamily } from '../family/types.ts';
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
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS],
  },
  find: {
    usageOverride: 'find <locator|text> <action> [value] [--first|--last]',
    helpDescription: 'Find by text/label/value/role/id and run action',
    summary: 'Find an element and act',
    positionalArgs: ['query', 'action', 'value?'],
    allowsExtraPositionals: true,
    allowedFlags: ['snapshotDepth', 'snapshotRaw', 'findFirst', 'findLast'],
  },
  is: {
    positionalArgs: ['predicate', 'selector', 'value?'],
    allowsExtraPositionals: true,
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS],
  },
  click: {
    usageOverride: 'click <x y|@ref|selector>',
    positionalArgs: ['target'],
    allowsExtraPositionals: true,
    allowedFlags: [...REPEATED_TOUCH_FLAGS, 'clickButton', ...SELECTOR_SNAPSHOT_FLAGS],
  },
  press: {
    usageOverride: 'press <x y|@ref|selector>',
    helpDescription:
      'Short press a semantic UI target by ref, selector, or point. For native context menus or hold gestures, use longpress <target> <durationMs> instead of press --hold-ms.',
    positionalArgs: ['targetOrX', 'y?'],
    allowsExtraPositionals: true,
    allowedFlags: [...REPEATED_TOUCH_FLAGS, ...SELECTOR_SNAPSHOT_FLAGS],
  },
  longpress: {
    usageOverride: 'longpress <x y|@ref|selector> [durationMs]',
    helpDescription:
      'Open native context menus or long-press targets by ref, selector, or point. Duration is positional, for example longpress @e12 800 or longpress 300 500 800.',
    positionalArgs: ['targetOrX', 'yOrDurationMs?', 'durationMs?'],
    allowsExtraPositionals: true,
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS],
  },
  swipe: {
    helpDescription: 'Swipe coordinates with optional repeat pattern',
    positionalArgs: ['x1', 'y1', 'x2', 'y2', 'durationMs?'],
    allowedFlags: ['count', 'pauseMs', 'pattern'],
  },
  gesture: {
    usageOverride: 'gesture <pan|fling|swipe|pinch|rotate|transform> ...',
    listUsageOverride: 'gesture <pan|fling|swipe|pinch|rotate|transform> ...',
    helpDescription:
      'Run touch gestures: pan <x> <y> <dx> <dy> [durationMs], fling <up|down|left|right> <x> <y> [distance] [durationMs], swipe <left|right|left-edge|right-edge> [durationMs], pinch <scale> [x] [y], rotate <degrees> [x] [y] [velocity], or transform <x> <y> <dx> <dy> <scale> <degrees> [durationMs]. For command plans, output only command lines. Android transform verification should use all app-observable effects, for example wait text "pan changed yes", wait text "pinch changed yes", and wait text "rotate changed yes", not exact transform values.',
    summary: 'Run pan, fling, swipe, pinch, rotate, or transform gestures',
    positionalArgs: ['pan|fling|swipe|pinch|rotate|transform', 'args?'],
    allowsExtraPositionals: true,
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
    allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS, 'delayMs'],
  },
  scroll: {
    usageOverride: 'scroll <direction|top|bottom> [amount] [--pixels <n>]',
    helpDescription: 'Scroll in a direction, or toward the top/bottom edge of scrollable content.',
    summary: 'Scroll in a direction or to an edge',
    positionalArgs: ['directionOrEdge', 'amount?'],
    allowedFlags: ['pixels'],
  },
} as const satisfies Record<string, CommandSchemaOverride>;

type InteractionCommandMetadata = (typeof interactionCommandMetadata)[number];
type InteractionCommandName = InteractionCommandMetadata['name'];

const interactionCommandDefinitions = [
  defineExecutableCommand(metadata('click'), (client, input) =>
    client.interactions.click(toClickOptions(input)),
  ),
  defineExecutableCommand(metadata('press'), (client, input) =>
    client.interactions.press(toPressOptions(input)),
  ),
  defineExecutableCommand(metadata('fill'), (client, input) =>
    client.interactions.fill(toFillOptions(input)),
  ),
  defineExecutableCommand(metadata('longpress'), (client, input) =>
    client.interactions.longPress(toLongPressOptions(input)),
  ),
  defineExecutableCommand(metadata('swipe'), (client, input) =>
    client.interactions.swipe(input as SwipeOptions),
  ),
  defineExecutableCommand(metadata('focus'), (client, input) =>
    client.interactions.focus(input as FocusOptions),
  ),
  defineExecutableCommand(metadata('type'), (client, input) =>
    client.interactions.type(input as TypeTextOptions),
  ),
  defineExecutableCommand(metadata('scroll'), (client, input) =>
    client.interactions.scroll(input as ScrollOptions),
  ),
  defineExecutableCommand(metadata('get'), (client, input) =>
    client.interactions.get(toGetOptions(input)),
  ),
  defineExecutableCommand(metadata('is'), (client, input) =>
    client.interactions.is(input as IsOptions),
  ),
  defineExecutableCommand(metadata('find'), (client, input) =>
    client.interactions.find(input as FindOptions),
  ),
  defineExecutableCommand(metadata('gesture'), async (client, input) => {
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
  }),
] as const;

export const interactionCommandFamily = defineCommandFamily({
  name: 'interaction',
  clientSurface: false,
  metadata: interactionCommandMetadata,
  definitions: interactionCommandDefinitions,
  cliSchemas: interactionCliSchemas,
  cliReaders: {
    ...interactionCliReaders,
    ...gestureCliReaders,
    ...selectorCliReaders,
  },
  daemonWriters: {
    ...interactionDaemonWriters,
    ...gestureDaemonWriters,
    ...selectorDaemonWriters,
  },
  cliOutputFormatters: interactionCliOutputFormatters,
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
  };
}

function toPressOptions(input: PressInput): PressOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    ...toRepeatedOptions(input),
  };
}

function toFillOptions(input: FillInput): FillOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    text: input.text,
    delayMs: input.delayMs,
  };
}

function toLongPressOptions(input: LongPressInput): LongPressOptions {
  return {
    ...commonToClientOptions(input),
    ...toClientInteractionTarget(input.target),
    ...toSelectorSnapshotOptions(input),
    durationMs: input.durationMs,
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
