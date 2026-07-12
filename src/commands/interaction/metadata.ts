import { defineCommandMetadata } from '../command-contract.ts';
import {
  booleanField,
  elementTargetField,
  enumField,
  fieldsInputSchema,
  integerField,
  interactionTargetField,
  numberField,
  pointField,
  readCommonInput,
  readFieldInput,
  readInputRecord,
  repeatedFields,
  requiredField,
  selectorSnapshotFields,
  stringField,
  type CommandFieldMap,
  type CommonCommandInput,
  type InferCommandInput,
} from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { CLICK_BUTTONS } from '../../core/click-button.ts';
import { SCROLL_DURATION_MAX_MS } from '../../contracts/scroll-command.ts';
import {
  SCROLL_DIRECTIONS,
  SWIPE_PAUSE_MAX_MS,
  SWIPE_PATTERNS,
  SWIPE_PRESETS,
  SWIPE_REPETITION_MAX,
} from '../../contracts/scroll-gesture.ts';
import { SCROLL_INPUT_DIRECTIONS } from './runtime/gestures.ts';
import { FIND_LOCATORS } from '../../selectors/find.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import type { PostActionObservationSupportFor } from '../../core/command-descriptor/post-action-observation.ts';
import {
  GESTURE_KINDS,
  readGesturePayload,
  type FlingGesturePayload,
  type PanGesturePayload,
  type PinchGesturePayload,
  type RotateGesturePayload,
  type SwipeGesturePayload,
  type TransformGesturePayload,
} from '../../contracts/gesture-input.ts';

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
  fill: 'Replace text in a semantic UI target by ref, selector, or point.',
  longpress: 'Long press by ref, selector, or point.',
  swipe: 'Swipe between two points.',
  focus: 'Focus input at coordinates.',
  type: 'Append text to the focused field.',
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
  durationMs: integerField('Deprecated: timed movement is a pan; omit for swipe.', {
    min: 16,
    max: 10_000,
  }),
  count: integerField('Number of swipe repetitions.', { min: 1, max: SWIPE_REPETITION_MAX }),
  pauseMs: integerField('Pause between repeated swipes.', { min: 0, max: SWIPE_PAUSE_MAX_MS }),
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
    enumField(['visible', 'hidden', 'exists', 'editable', 'selected', 'focused', 'text'] as const),
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
  velocity: numberField('Deprecated: rotation pacing is derived from degrees; must be non-zero.'),
  durationMs: integerField(
    'Pan/transform duration. Deprecated on swipe/fling; timed movement is a pan.',
    { min: 16, max: 10_000 },
  ),
  pointerCount: integerField('Pan touch pointer count (1 or 2).', { min: 1, max: 2 }),
};

export type ClickInput = InferCommandInput<typeof clickFields>;
export type PressInput = InferCommandInput<typeof pressFields>;
export type FillInput = InferCommandInput<typeof fillFields>;
export type LongPressInput = InferCommandInput<typeof longPressFields>;
export type GetInput = InferCommandInput<typeof getFields>;

export type PanInput = CommonCommandInput & PanGesturePayload;
export type FlingInput = CommonCommandInput & FlingGesturePayload;
export type SwipeGestureInput = CommonCommandInput & SwipeGesturePayload;
export type PinchInput = CommonCommandInput & PinchGesturePayload;
export type RotateInput = CommonCommandInput & RotateGesturePayload;
export type TransformInput = CommonCommandInput & TransformGesturePayload;

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

export function readGestureInput(input: unknown): GestureInput {
  const record = readInputRecord(input);
  return { ...readCommonInput(record), ...readGesturePayload(record) } as GestureInput;
}

function defineInteractionCommandMetadata<
  const TName extends InteractionCommandName,
  const TFields extends CommandFieldMap,
>(name: TName, fields: TFields) {
  return defineFieldCommandMetadata(name, interactionCommandDescriptions[name], fields);
}
