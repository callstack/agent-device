import { defineCommandMetadata } from '../command-contract.ts';
import { GESTURE_KINDS } from '../../command-catalog.ts';
import {
  booleanField,
  elementTargetField,
  enumField,
  fieldsInputSchema,
  integerField,
  interactionTargetField,
  numberField,
  optionalInteger,
  pointField,
  readCommonInput,
  readFieldInput,
  readInputRecord,
  readPoint,
  repeatedFields,
  requiredEnum,
  requiredField,
  requiredNumber,
  selectorSnapshotFields,
  stringField,
  type CommandFieldMap,
  type CommonCommandInput,
  type InferCommandInput,
  type PointInput,
} from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { CLICK_BUTTONS } from '../../core/click-button.ts';
import { SCROLL_DURATION_MAX_MS } from '../../core/scroll-command.ts';
import {
  SCROLL_DIRECTIONS,
  SWIPE_PATTERNS,
  SWIPE_PRESETS,
  type ScrollDirection,
  type SwipePreset,
} from '../../core/scroll-gesture.ts';
import { SCROLL_INPUT_DIRECTIONS } from './runtime/gestures.ts';
import { FIND_LOCATORS } from '../../utils/finders.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import type { PostActionObservationSupportFor } from '../../core/command-descriptor/post-action-observation.ts';

const FIND_ACTION_VALUES = [
  'click',
  'focus',
  'exists',
  'getText',
  'getAttrs',
  'wait',
  'fill',
  'type',
] as const;

const interactionCommandDescriptions = {
  click: 'Click or tap a semantic UI target by ref, selector, or point.',
  press: 'Press a semantic UI target by ref, selector, or point.',
  fill: 'Fill text into a semantic UI target by ref, selector, or point.',
  longpress: 'Long press by ref, selector, or point.',
  swipe: 'Swipe between two points.',
  focus: 'Focus input at coordinates.',
  type: 'Type text in the focused field.',
  scroll: 'Scroll in a direction or to an edge.',
  get: 'Get element text or attributes.',
  is: 'Assert UI state.',
  find: 'Find an element and optionally act on it.',
  gesture: 'Run a structured gesture.',
} as const;

type InteractionCommandName = keyof typeof interactionCommandDescriptions;

const verifyField = () =>
  booleanField(
    'Capture cheap post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot.',
  );

const settleFields = () => ({
  settle: booleanField(
    'After the action, wait for the UI to go quiet and return the settled diff vs the pre-action tree in the same response. Best-effort; never fails the action.',
  ),
  settleQuietMs: integerField('Settle: quiet window in milliseconds (default 500).', { min: 0 }),
  timeoutMs: integerField('Settle: wait deadline in milliseconds (default 10000).', { min: 1 }),
});

type VerifyFieldMap = { verify: ReturnType<typeof verifyField> };
type SettleFieldMap = ReturnType<typeof settleFields>;
type PostActionObservationFields<TName extends string> =
  PostActionObservationSupportFor<TName> extends 'settle-and-verify'
    ? VerifyFieldMap & SettleFieldMap
    : PostActionObservationSupportFor<TName> extends 'settle'
      ? SettleFieldMap
      : {};

function postActionObservationFields<const TName extends InteractionCommandName>(
  command: TName,
): PostActionObservationFields<TName> {
  return {
    ...(commandSupportsVerifyEvidence(command) ? { verify: verifyField() } : {}),
    ...(commandSupportsSettleObservation(command) ? settleFields() : {}),
  } as PostActionObservationFields<TName>;
}

const clickFields = {
  target: requiredField(interactionTargetField()),
  button: enumField(CLICK_BUTTONS, 'Pointer button for platforms that support mouse buttons.'),
  ...selectorSnapshotFields(),
  ...repeatedFields(),
  ...postActionObservationFields('click'),
};

const pressFields = {
  target: requiredField(interactionTargetField()),
  ...selectorSnapshotFields(),
  ...repeatedFields(),
  ...postActionObservationFields('press'),
};

const fillFields = {
  target: requiredField(interactionTargetField()),
  text: requiredField(stringField('Text to enter into the target.')),
  delayMs: integerField('Delay between typed characters.', { min: 0 }),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('fill'),
};

const longPressFields = {
  target: requiredField(interactionTargetField()),
  durationMs: integerField('Long press duration in milliseconds.', { min: 0 }),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('longpress'),
};

const swipeFields = {
  from: requiredField(pointField('Swipe start point.')),
  to: requiredField(pointField('Swipe end point.')),
  durationMs: integerField('Swipe duration in milliseconds.', { min: 0 }),
  count: integerField('Number of swipe repetitions.', { min: 1 }),
  pauseMs: integerField('Pause between repeated swipes.', { min: 0 }),
  pattern: enumField(SWIPE_PATTERNS),
};

const focusFields = {
  x: requiredField(numberField('X coordinate.')),
  y: requiredField(numberField('Y coordinate.')),
};

const typeFields = {
  text: requiredField(stringField('Text to type.')),
  delayMs: integerField('Delay between typed characters.', { min: 0 }),
};

const scrollFields = {
  direction: requiredField(enumField(SCROLL_INPUT_DIRECTIONS)),
  amount: numberField('Platform scroll amount.'),
  pixels: integerField('Pixel scroll amount.', { min: 0 }),
  durationMs: integerField('Scroll duration in milliseconds when the backend supports pacing.', {
    min: 0,
    max: SCROLL_DURATION_MAX_MS,
  }),
};

const getFields = {
  format: requiredField(enumField(['text', 'attrs'] as const)),
  target: requiredField(elementTargetField()),
  ...selectorSnapshotFields(),
};

const isFields = {
  predicate: requiredField(
    enumField(['visible', 'hidden', 'exists', 'editable', 'selected', 'text'] as const),
  ),
  selector: requiredField(stringField()),
  value: stringField(),
  ...selectorSnapshotFields(),
};

const findFields = {
  locator: enumField(FIND_LOCATORS),
  query: requiredField(stringField()),
  action: enumField(FIND_ACTION_VALUES),
  value: stringField(),
  timeoutMs: integerField(),
  first: booleanField(),
  last: booleanField(),
  depth: integerField(),
  raw: booleanField(),
};

const gestureFields = {
  kind: requiredField(enumField(GESTURE_KINDS, 'Gesture variant.')),
  direction: enumField(SCROLL_DIRECTIONS, 'Fling direction.'),
  preset: enumField(SWIPE_PRESETS, 'Swipe preset.'),
  origin: pointField('Gesture origin point.'),
  delta: pointField('Movement delta for pan or transform gestures.'),
  distance: integerField('Fling distance.', { min: 0 }),
  scale: numberField('Pinch or transform scale.'),
  degrees: numberField('Rotation in degrees.'),
  velocity: integerField('Rotate gesture velocity.', { min: 0 }),
  durationMs: integerField('Gesture duration in milliseconds.', { min: 0 }),
};

export type ClickInput = InferCommandInput<typeof clickFields>;
export type PressInput = InferCommandInput<typeof pressFields>;
export type FillInput = InferCommandInput<typeof fillFields>;
export type LongPressInput = InferCommandInput<typeof longPressFields>;
export type GetInput = InferCommandInput<typeof getFields>;

export type PanInput = CommonCommandInput & {
  kind: 'pan';
  origin: PointInput;
  delta: PointInput;
  durationMs?: number;
};

export type FlingInput = CommonCommandInput & {
  kind: 'fling';
  direction: ScrollDirection;
  origin: PointInput;
  distance?: number;
  durationMs?: number;
};

export type SwipeGestureInput = CommonCommandInput & {
  kind: 'swipe';
  preset: SwipePreset;
  durationMs?: number;
};

export type PinchInput = CommonCommandInput & {
  kind: 'pinch';
  scale: number;
  origin?: PointInput;
};

export type RotateInput = CommonCommandInput & {
  kind: 'rotate';
  degrees: number;
  origin?: PointInput;
  velocity?: number;
};

export type TransformInput = CommonCommandInput & {
  kind: 'transform';
  origin: PointInput;
  delta: PointInput;
  scale: number;
  degrees: number;
  durationMs?: number;
};

export type GestureInput =
  | PanInput
  | FlingInput
  | SwipeGestureInput
  | PinchInput
  | RotateInput
  | TransformInput;

export const interactionCommandMetadata = [
  defineCommandMetadata({
    name: 'click',
    description: interactionCommandDescriptions.click,
    inputSchema: fieldsInputSchema(clickFields),
    readInput: (input) => readFieldInput(input, clickFields),
  }),
  defineCommandMetadata({
    name: 'press',
    description: interactionCommandDescriptions.press,
    inputSchema: fieldsInputSchema(pressFields),
    readInput: (input) => readFieldInput(input, pressFields),
  }),
  defineCommandMetadata({
    name: 'fill',
    description: interactionCommandDescriptions.fill,
    inputSchema: fieldsInputSchema(fillFields),
    readInput: (input) => readFieldInput(input, fillFields),
  }),
  defineInteractionCommandMetadata('longpress', longPressFields),
  defineInteractionCommandMetadata('swipe', swipeFields),
  defineInteractionCommandMetadata('focus', focusFields),
  defineInteractionCommandMetadata('type', typeFields),
  defineInteractionCommandMetadata('scroll', scrollFields),
  defineInteractionCommandMetadata('get', getFields),
  defineInteractionCommandMetadata('is', isFields),
  defineInteractionCommandMetadata('find', findFields),
  defineCommandMetadata({
    name: 'gesture',
    description: interactionCommandDescriptions.gesture,
    inputSchema: fieldsInputSchema(gestureFields),
    readInput: readGestureInput,
  }),
] as const;

function readGestureInput(input: unknown): GestureInput {
  const record = readInputRecord(input);
  const common = readCommonInput(record);
  const kind = requiredEnum(record, 'kind', GESTURE_KINDS);
  if (kind === 'pan') {
    return {
      ...common,
      kind,
      origin: readPoint(record, 'origin'),
      delta: readPoint(record, 'delta'),
      durationMs: optionalInteger(record, 'durationMs', { min: 0 }),
    };
  }
  if (kind === 'fling') {
    return {
      ...common,
      kind,
      direction: requiredEnum(record, 'direction', SCROLL_DIRECTIONS),
      origin: readPoint(record, 'origin'),
      distance: optionalInteger(record, 'distance', { min: 0 }),
      durationMs: optionalInteger(record, 'durationMs', { min: 0 }),
    };
  }
  if (kind === 'swipe') {
    return {
      ...common,
      kind,
      preset: requiredEnum(record, 'preset', SWIPE_PRESETS),
      durationMs: optionalInteger(record, 'durationMs', { min: 0 }),
    };
  }
  if (kind === 'pinch') {
    return {
      ...common,
      kind,
      scale: requiredNumber(record, 'scale'),
      origin: optionalPoint(record, 'origin'),
    };
  }
  if (kind === 'rotate') {
    return {
      ...common,
      kind,
      degrees: requiredNumber(record, 'degrees'),
      origin: optionalPoint(record, 'origin'),
      velocity: optionalInteger(record, 'velocity', { min: 0 }),
    };
  }
  return {
    ...common,
    kind,
    origin: readPoint(record, 'origin'),
    delta: readPoint(record, 'delta'),
    scale: requiredNumber(record, 'scale'),
    degrees: requiredNumber(record, 'degrees'),
    durationMs: optionalInteger(record, 'durationMs', { min: 0 }),
  };
}

function defineInteractionCommandMetadata<
  const TName extends InteractionCommandName,
  const TFields extends CommandFieldMap,
>(name: TName, fields: TFields) {
  return defineFieldCommandMetadata(name, interactionCommandDescriptions[name], fields);
}

function optionalPoint(record: Record<string, unknown>, key: string): PointInput | undefined {
  return record[key] === undefined ? undefined : readPoint(record, key);
}
