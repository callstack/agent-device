import {
  CLICK_BUTTONS,
  GESTURE_KINDS,
  readGesturePayload,
  SCROLL_DIRECTIONS,
  SCROLL_DURATION_MAX_MS,
  SWIPE_PATTERNS,
  SWIPE_PAUSE_MAX_MS,
  SWIPE_PRESETS,
  SWIPE_REPETITION_MAX,
  type FlingGesturePayload,
  type DragGesturePayload,
  type PanGesturePayload,
  type PinchGesturePayload,
  type RotateGesturePayload,
  type SwipeGesturePayload,
  type TransformGesturePayload,
} from '@agent-device/contracts/interaction';
import type { PostActionObservationSupportFor } from '../../core/command-descriptor/post-action-observation.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import { FIND_LOCATORS } from '@agent-device/selectors';
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
import { SCROLL_INPUT_DIRECTIONS } from './runtime/gestures.ts';

const FIND_ACTION_VALUES = [
  'click',
  'focus',
  'exists',
  'list',
  'getText',
  'getAttrs',
  'wait',
  'fill',
  'type',
] as const;

const interactionCommandDescriptions = {
  click:
    'Activate a UI target by snapshot ref, selector, or coordinates. Prefer a ref or selector after a snapshot; use coordinates only when semantic targeting is unavailable. This can change app state; use settle or verify to confirm the result without a follow-up snapshot.',
  press:
    'Short-press a UI target by snapshot ref, selector, or coordinates. Use longpress instead when the target requires a context-menu or hold gesture.',
  fill: 'Replace text in a UI input selected by snapshot ref, selector, or coordinates. Prefer refs or selectors after snapshot; use recordAs to keep sensitive text out of a recorded replay while sending it to the live app.',
  longpress:
    'Hold a UI target by snapshot ref, selector, or coordinates to open a context menu or perform another hold gesture. Set durationMs when the default hold duration is unsuitable.',
  swipe: 'Quick coordinate fling with optional repeat pattern.',
  focus:
    'Move input focus to explicit screen coordinates without entering text. Prefer semantic interactions when a snapshot ref or selector is available; use type or fill after focus.',
  type: 'Append text to the currently focused input. Use fill when the existing field value should be replaced, and focus first when no input is active.',
  scroll: 'Scroll in a direction, or toward the top/bottom edge of scrollable content.',
  get: 'Read text or accessibility attributes from a snapshot ref or selector without changing the app. Use format text for visible content or attrs for the element attribute map.',
  is: 'Check whether a selector satisfies a UI predicate such as visible, hidden, editable, selected, focused, or text. Use wait when the condition may appear asynchronously.',
  find: 'Find by text/label/value/role/id and run action',
  gesture:
    'Perform a structured pan, fling, swipe, pinch, rotate, transform, or drag gesture. Select the gesture kind, then provide only the inputs that apply to that kind.',
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
  recordAs: stringField(
    'When script recording is armed, send text to the live app but publish it as ${VAR}. Use an uppercase replay variable name such as PASSWORD.',
  ),
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

// #1271 stage 2 (ADR 0012 amendment): `get`/`is`/`find` are observation-only,
// so a repair-armed heal excludes an OUT-OF-BAND one by default. Both flags
// are exposed here so the Node SDK's typed options and the MCP tool schema can
// set them, mirroring `--no-record`/`--record` on the CLI. On `find`, `record`
// is valid only for a read-only action — a mutating `find … click|fill|focus|
// type` is refused as INVALID_ARGS by the daemon (`handleFindCommands`), since
// the observe-vs-mutate split is a positional the schema cannot see.
const recordControlFields = () => ({
  noRecord: booleanField('Do not record this action.'),
  record: booleanField(
    'Force-record this out-of-band observation into a repair-armed heal (mutually exclusive with noRecord). Authored replay steps are recorded automatically and never need this. On find, valid only for a read-only action.',
  ),
});

const getFields = {
  format: requiredField(enumField(['text', 'attrs'] as const)),
  target: requiredField(elementTargetField()),
  ...selectorSnapshotFields(),
  ...recordControlFields(),
};

const isFields = {
  predicate: requiredField(
    enumField(['visible', 'hidden', 'exists', 'editable', 'selected', 'focused', 'text'] as const),
  ),
  selector: requiredField(stringField()),
  value: stringField(),
  ...selectorSnapshotFields(),
  ...recordControlFields(),
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
  ...recordControlFields(),
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
  durationMs: integerField('Pan/transform duration.', { min: 16, max: 10_000 }),
  pointerCount: integerField('Pan touch pointer count (1 or 2).', { min: 1, max: 2 }),
  source: stringField('Drag source @ref or selector.'),
  destination: stringField('Drag destination @ref or selector.'),
  sourceHoldMs: integerField('Drag activation hold duration.', { min: 1, max: 10_000 }),
  moveMs: integerField('Drag movement duration.', { min: 16, max: 10_000 }),
  destinationHoldMs: integerField('Hold before releasing at the destination.', {
    min: 0,
    max: 10_000,
  }),
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
export type DragInput = CommonCommandInput & DragGesturePayload;

export type GestureInput =
  | PanInput
  | FlingInput
  | SwipeGestureInput
  | PinchInput
  | RotateInput
  | TransformInput
  | DragInput;

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
