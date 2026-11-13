import { CLICK_BUTTONS } from '@agent-device/contracts/click-button';
import type { ElementTarget } from '@agent-device/contracts/client';
import {
  GESTURE_KINDS,
  type GesturePayload,
  readGesturePayload,
} from '@agent-device/contracts/gesture-input';
import {
  GESTURE_DURATION_MAX_MS,
  GESTURE_DURATION_MIN_MS,
  GESTURE_MAX_CONTACTS,
  GESTURE_TAP_MIN_CONTACTS,
} from '@agent-device/contracts/gesture-plan-types';
import {
  DEFAULT_SCROLL_UNTIL_PASSES,
  SCROLL_DURATION_MAX_MS,
  SCROLL_UNTIL_MAX_PASSES,
} from '@agent-device/contracts/scroll-command';
import { IS_PREDICATES } from '@agent-device/contracts/is-predicate';
import {
  SCROLL_DIRECTIONS,
  SCROLL_INPUT_DIRECTIONS,
  SWIPE_PATTERNS,
  SWIPE_PAUSE_MAX_MS,
  SWIPE_PRESETS,
  SWIPE_REPETITION_MAX,
} from '@agent-device/contracts/scroll-gesture';
import { FIND_LOCATORS } from '@agent-device/selectors';
import {
  TARGET_INPUT_EXAMPLE,
  booleanField,
  elementTargetFields,
  enumField,
  integerField,
  interactionTargetFields,
  numberField,
  operatorField,
  pointArrayField,
  pointField,
  postGestureStabilizationFields,
  readTargetedInput,
  repeatedFields,
  requiredField,
  selectorSnapshotFields,
  stringField,
  type CommandFieldMap,
  type TargetedInput,
} from '../command-input.ts';
import { readCommonInput, type CommonCommandInput } from '../common-input-fields.ts';
import { optionalBoolean, readInputRecord } from '../input-readers.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { postActionObservationFields } from '../post-action-observation-grammar.ts';

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
    "Activate a UI target by snapshot ref, selector, or coordinates. This can change app state. Success reports dispatch only; settle returns the resulting UI diff and verify returns cheap post-action evidence. A ref or selector target is re-checked for motion before dispatch when the session's previous action just animated the screen, and is dispatched at its resting position; one that has not stopped refuses with target_still_moving rather than acting where it was. dispatches one action per key in order as one command, with the admission, rest, and refusal contract press documents for its sequence.",
  press:
    "Short-press a UI target by snapshot ref, selector, or coordinates. Success reports dispatch only; settle returns the resulting UI diff and verify returns cheap post-action evidence. A ref or selector target is re-checked for motion before dispatch when the session's previous action just animated the screen, and is dispatched at its resting position; one that has not stopped refuses with target_still_moving rather than acting where it was. A comma-separated ref list (target `@e13,@e14,@e15,@e16`) presses each key once in order as one command; pass refs as a list of 2 to 16 snapshot refs (a repeated ref presses the same key twice), and the response carries a sequence summary with the refs, the keys pressed, and where each landed. The plan resolves and admits against the current frame before the first press; key 1 expires the frame, later keys tap where the snapshot showed them, and a later key that refuses carries the keys already sent in details.dispatchedSteps.",
  fill: 'Replace text in a UI input selected by snapshot ref, selector, or coordinates. An empty text clears the field. Unconfirmed evidence does not establish the resulting value or screen. The recordAs option keeps sensitive text out of a recorded replay while sending it to the live app.',
  longpress:
    'Hold a UI target by snapshot ref, selector, or coordinates to open a context menu or perform another hold gesture. The durationMs input overrides the default hold duration.',
  hover:
    'Move the pointer over a UI target by snapshot ref, selector, or coordinates without pressing, to reveal hover-gated UI such as row toolbars or menus. Web only; touch platforms have no hover state. The settle option returns the UI diff revealed by the hover.',
  swipe: 'Quick coordinate fling with optional repeat pattern.',
  focus:
    'Move input focus to explicit screen coordinates without entering text. This command changes focus only and does not enter or replace text.',
  type: 'Append text to the currently focused input. This requires an active input and preserves its existing text.',
  scroll:
    'Scroll in a direction, or toward the top/bottom edge of scrollable content. The until input scrolls to an off-screen selector in one command. The optional amount is the finger-path fraction of the viewport axis, honored up to 0.8 of it; directional scrolls reduce release momentum, while app scroll physics determine the final content offset. A visible keyboard shortens the swiped band instead of being dismissed; when too little is left, the command refuses with scroll_keyboard_occludes_surface. A directional scroll also reports the movement it observed as movement: moved, at-edge, unchanged, or unobserved when the two reads could not back a claim either way; an unchanged surface inside a container that still hides content in that direction refuses with scroll_no_progress rather than repeating the requested distance. The movement field is absent where a tier verifies per pass (top/bottom, until), where the runtime cannot read a screen, where a settle observation or a replay already owns that observation, or where the operator opted out of it.',
  get: 'Read text or accessibility attributes from a snapshot ref or selector without changing the app. The text format returns visible content; attrs returns the element attribute map.',
  is: 'Check whether a selector satisfies a UI predicate such as visible, hidden, exists, absent, editable, selected, focused, or text. `absent` passes only when one readable, complete, settled, unscoped, full-depth accessibility capture has zero matches. This command checks the current condition without polling.',
  find: 'Find by text/label/value/role/id and run action; the action defaults to click. The role locator matches snapshot kind vocabulary (button, text, text-field, switch, ...); pre-reconciliation leaf spellings (statictext, edittext, textview) stay accepted on the nodes that carried them during a deprecation window. The focus and type actions aim at a text field: the match or the field holding it, even beside other fields, or else the one enabled on-screen field inside the match. Several enabled on-screen fields inside the match refuse with AMBIGUOUS_MATCH and the field candidates, and a disabled target refuses with reason target_disabled. Web text boxes are not recognized as text fields.',
  gesture:
    'Perform a structured pan, fling, swipe, pinch, rotate, transform, tap, or drag gesture. Each gesture kind has its own inputs. A tap touches 2 to 5 points at once; count and pauseMs control repetition.',
} as const;

type InteractionCommandName = keyof typeof interactionCommandDescriptions;

const clickFields = {
  ...interactionTargetFields(),
  button: enumField(CLICK_BUTTONS, 'Pointer button for platforms that support mouse buttons.'),
  ...selectorSnapshotFields(),
  ...repeatedFields(),
  ...postActionObservationFields('click'),
};

const pressFields = {
  ...interactionTargetFields(),
  ...selectorSnapshotFields(),
  ...repeatedFields(),
  ...postActionObservationFields('press'),
};

const fillFields = {
  ...interactionTargetFields(),
  // "" is accepted and means "replace with nothing", i.e. clear the field (#2063). The key
  // must still be present: omitting it is a missing argument, not a clear.
  text: requiredField(
    stringField('Text to enter into the target. Pass "" to clear it.', { allowEmpty: true }),
  ),
  delayMs: integerField('Delay between typed characters.', { min: 0 }),
  recordAs: stringField(
    'When script recording is armed, send text to the live app but publish it as ${VAR}. Use an uppercase replay variable name such as PASSWORD.',
  ),
  textStdin: operatorField(
    booleanField(
      "Operator-only: text was read from the CLI's stdin, so it is kept out of diagnostics and recorded actions.",
    ),
    {
      operatorPath:
        'Pass --text-stdin on the CLI and pipe the text in; it is not exposed to model-facing tools.',
    },
  ),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('fill'),
};

const longPressFields = {
  ...interactionTargetFields(),
  durationMs: integerField('Long press duration in milliseconds.', { min: 0 }),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('longpress'),
};

const hoverFields = {
  ...interactionTargetFields(),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('hover'),
};

const swipeFields = {
  from: requiredField(pointField('Swipe start point.')),
  to: requiredField(pointField('Swipe end point.')),
  count: integerField('Number of swipe repetitions.', { min: 1, max: SWIPE_REPETITION_MAX }),
  pauseMs: integerField('Pause between repeated swipes.', { min: 0, max: SWIPE_PAUSE_MAX_MS }),
  pattern: enumField(SWIPE_PATTERNS),
  ...postGestureStabilizationFields(),
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
  until: stringField(
    'Repeat scroll passes until this selector is visible on screen, then stop. Not valid with the top/bottom edge directions, which carry their own stop condition.',
  ),
  maxPasses: integerField(
    `Maximum scroll gestures for an until search (default ${DEFAULT_SCROLL_UNTIL_PASSES}). Requires until.`,
    {
      min: 1,
      max: SCROLL_UNTIL_MAX_PASSES,
    },
  ),
  durationMs: integerField('Scroll duration in milliseconds when the backend supports pacing.', {
    min: 0,
    max: SCROLL_DURATION_MAX_MS,
  }),
  ...postActionObservationFields('scroll'),
  ...postGestureStabilizationFields(),
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
  ...elementTargetFields(),
  ...selectorSnapshotFields(),
  ...recordControlFields(),
};

const isFields = {
  predicate: requiredField(enumField(IS_PREDICATES)),
  selector: requiredField(stringField()),
  value: stringField(),
  ...selectorSnapshotFields(),
  ...recordControlFields(),
};

const findFields = {
  locator: enumField(FIND_LOCATORS),
  query: requiredField(stringField()),
  action: enumField(FIND_ACTION_VALUES),
  // `find <q> fill ""` is the clear request (#2063); the daemon handler still refuses a MISSING
  // value, and an empty `type` value.
  value: stringField(undefined, { allowEmpty: true }),
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
  ...postGestureStabilizationFields(),
  origin: pointField('Gesture origin point.'),
  delta: pointField('Movement delta for pan or transform gestures.'),
  distance: integerField('Fling distance.', { min: 0 }),
  scale: numberField('Pinch or transform scale.'),
  degrees: numberField('Rotation in degrees.'),
  durationMs: integerField('Pan/transform duration.', { min: 16, max: 10_000 }),
  pointerCount: integerField('Pan touch pointer count (1 or 2).', { min: 1, max: 2 }),
  points: pointArrayField('Tap contact points, held together for holdMs.', {
    min: GESTURE_TAP_MIN_CONTACTS,
    max: GESTURE_MAX_CONTACTS,
  }),
  holdMs: integerField('Tap contact hold duration.', {
    min: GESTURE_DURATION_MIN_MS,
    max: GESTURE_DURATION_MAX_MS,
  }),
  count: integerField('Tap repetitions; the same contacts run this many times.', {
    min: 1,
    max: SWIPE_REPETITION_MAX,
  }),
  pauseMs: integerField('Delay between tap repetitions, added to each repetition’s own time.', {
    min: 0,
    max: SWIPE_PAUSE_MAX_MS,
  }),
  source: stringField('Drag source @ref or selector.'),
  destination: stringField('Drag destination @ref or selector.'),
  sourceHoldMs: integerField('Drag activation hold duration.', { min: 1, max: 10_000 }),
  moveMs: integerField('Drag movement duration.', { min: 16, max: 10_000 }),
  destinationHoldMs: integerField('Hold before releasing at the destination.', {
    min: 0,
    max: 10_000,
  }),
};

export type ClickInput = TargetedInput<typeof clickFields>;
export type PressInput = TargetedInput<typeof pressFields>;
export type FillInput = TargetedInput<typeof fillFields>;
export type LongPressInput = TargetedInput<typeof longPressFields>;
export type HoverInput = TargetedInput<typeof hoverFields>;
export type GetInput = TargetedInput<typeof getFields, ElementTarget>;

export type GestureInput = CommonCommandInput & GesturePayload;

/** What `gesture` reads from a caller: the daemon's input, plus the opt-out a swipe may carry. */
export type GestureCommandInput = GestureInput & { postGestureStabilization?: boolean };

export const interactionCommandMetadata = [
  defineTargetedCommandMetadata('click', clickFields),
  defineTargetedCommandMetadata('press', pressFields),
  defineTargetedCommandMetadata('fill', fillFields),
  defineTargetedCommandMetadata('longpress', longPressFields),
  defineTargetedCommandMetadata('hover', hoverFields),
  defineInteractionCommandMetadata('swipe', swipeFields),
  defineInteractionCommandMetadata('focus', focusFields),
  defineInteractionCommandMetadata('type', typeFields),
  defineInteractionCommandMetadata('scroll', scrollFields),
  defineFieldCommandMetadata('get', interactionCommandDescriptions.get, getFields, {
    readInput: (input: unknown): GetInput =>
      readTargetedInput<typeof getFields, ElementTarget>(input, getFields),
    inputExample: TARGET_INPUT_EXAMPLE,
    parseableOutput: true,
  }),
  defineInteractionCommandMetadata('is', isFields),
  defineInteractionCommandMetadata('find', findFields, { parseableOutput: true }),
  defineFieldCommandMetadata('gesture', interactionCommandDescriptions.gesture, gestureFields, {
    readInput: readGestureCommandInput,
    inputExample: { kind: 'pan', origin: { x: 200, y: 400 }, delta: { x: 0, y: -200 } },
  }),
] as const;

/** The input the daemon receives. The client projects the opt-out onto a flag, so it is not here. */
export function readGestureInput(input: unknown): GestureInput {
  const record = readInputRecord(input);
  return { ...readCommonInput(record), ...readGesturePayload(record) };
}

/** Only a swipe stabilizes by default, so any other kind has nothing to opt out of and drops it. */
function readGestureCommandInput(input: unknown): GestureCommandInput {
  const record = readInputRecord(input);
  const gesture = readGestureInput(record);
  return gesture.kind === 'swipe' && optionalBoolean(record, 'postGestureStabilization') === false
    ? { ...gesture, postGestureStabilization: false }
    : gesture;
}

function defineTargetedCommandMetadata<
  const TName extends InteractionCommandName,
  const TFields extends CommandFieldMap,
>(name: TName, fields: TFields) {
  return defineFieldCommandMetadata(name, interactionCommandDescriptions[name], fields, {
    readInput: (input: unknown): TargetedInput<TFields> => readTargetedInput(input, fields),
    inputExample: TARGET_INPUT_EXAMPLE,
  });
}

function defineInteractionCommandMetadata<
  const TName extends InteractionCommandName,
  const TFields extends CommandFieldMap,
>(name: TName, fields: TFields, options?: { parseableOutput?: true }) {
  return defineFieldCommandMetadata(name, interactionCommandDescriptions[name], fields, options);
}
