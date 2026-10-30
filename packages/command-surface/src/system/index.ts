import { FOLD_FLAGS } from '@agent-device/command-registry/flag-groups';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import type { ClipboardCommandOptions } from '@agent-device/contracts/client';
import {
  type FoldKeyframe,
  FOLD_SCREEN_COORDINATE_SPACE,
  MAX_FOLD_DURATION_MS,
  MAX_FOLD_KEYFRAMES,
  parseFoldInput,
  parseFoldKeyframesJson,
  ORIENTATION_REQUESTS,
  FOLD_POSES,
  FOLD_POSE_USAGE,
  parseOrientationRequest,
  TELEPHONY_ACTIONS,
  TELEPHONY_CALL_ACTIONS,
  TELEPHONY_USAGE,
  parseTelephonyEventInput,
  parseTelephonyPositionals,
  telephonyPositionals,
  // The hardware-button vocabulary arrives through the same eager device-vocabulary façade the
  // orientation and fold readers use (#3848, eager-closure budgets).
  HARDWARE_BUTTON_NAMES,
  HARDWARE_BUTTON_NAME_LABELS,
  HARDWARE_BUTTON_USAGE,
  parseHardwareButtonPositionals,
} from '@agent-device/contracts/device';
import { type BackMode, BACK_MODES } from '@agent-device/contracts/back-mode';
import {
  type TvRemoteButton,
  TV_REMOTE_BUTTONS,
  TV_REMOTE_ANDROID_KEYCODE_PATTERN,
  TV_REMOTE_BUTTON_USAGE,
  parseTvRemoteButton,
  tvRemoteDurationMode,
} from '@agent-device/contracts/tv-remote';
import { APPLE_APPLICATION_STATES } from '@agent-device/kernel/snapshot';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import {
  commonInputFromFlags,
  direct,
  optionalString,
  request,
  requiredDaemonString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import type { JsonSchema } from '../command-contract.ts';
import {
  customField,
  enumField,
  integerField,
  requiredField,
  stringField,
  jsonSchemaField,
  readFieldInput,
  booleanSchema,
  constSchema,
  enumSchema,
  numberSchema,
  objectSchema,
  stringSchema,
} from '../command-input.ts';
import { compactRecord } from '../input-readers.ts';
import {
  defineCommandFacet,
  defineCommandFamilyFromFacets,
  defineParameterlessCommandFacet,
} from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  postActionObservationCliFlags,
  postActionObservationFields,
} from '../post-action-observation-grammar.ts';

const APPSTATE_COMMAND_NAME = 'appstate';
const BACK_COMMAND_NAME = 'back';
const HOME_COMMAND_NAME = 'home';
const ORIENTATION_COMMAND_NAME = 'orientation';
const FOLD_COMMAND_NAME = 'fold';
const APP_SWITCHER_COMMAND_NAME = 'app-switcher';
const ACTION_BUTTON_COMMAND_NAME = 'action-button';
const HARDWARE_BUTTON_COMMAND_NAME = 'hardware-button';
const KEYBOARD_COMMAND_NAME = 'keyboard';
const CLIPBOARD_COMMAND_NAME = 'clipboard';
const TV_REMOTE_COMMAND_NAME = 'tv-remote';
const TELEPHONY_COMMAND_NAME = 'telephony';
const TV_REMOTE_LONGPRESS_PRESET_MS = 500;

const CLIPBOARD_ACTION_VALUES = ['read', 'write'] as const;
const KEYBOARD_METADATA_ACTION_VALUES = ['status', 'dismiss', 'enter', 'return'] as const;

const tvRemoteButtonSchema: JsonSchema = {
  description:
    'TV remote button. Android TV also accepts android-keycode:<n> with n from 1 to 2147483647.',
  oneOf: [
    enumSchema(TV_REMOTE_BUTTONS),
    { type: 'string', pattern: TV_REMOTE_ANDROID_KEYCODE_PATTERN.source },
  ],
};

/**
 * This family's advertised MCP `outputSchema`s, keyed by daemon command name and projected into
 * the command map by `command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields such as `settle`/`cost` keep
 * validating. `back`'s settle observation is grafted separately by the trait derivation pass.
 */
export const SYSTEM_COMMAND_OUTPUT_SCHEMAS = {
  back: objectSchema(
    {
      action: constSchema('back'),
      mode: enumSchema(BACK_MODES),
      message: stringSchema(),
    },
    ['action', 'mode', 'message'],
  ),
  home: objectSchema({ action: constSchema('home'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  orientation: objectSchema(
    {
      action: constSchema('orientation'),
      orientation: enumSchema(ORIENTATION_REQUESTS),
      message: stringSchema(),
      confirmed: booleanSchema(),
      warning: stringSchema(),
    },
    ['action', 'orientation', 'message'],
  ),
  'app-switcher': objectSchema({ action: constSchema('app-switcher'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  fold: objectSchema(
    {
      action: constSchema('fold'),
      pose: enumSchema(FOLD_POSES),
      hingeAngleDegrees: numberSchema(
        'Hinge angle read back after the pose settled: from CoreMotion inside the simulator on iOS, from the emulator hinge sensor on Android.',
      ),
      screen: objectSchema(
        {
          display: stringSchema('CoreDevice name of the panel the device now lights.'),
          coordinateSpace: constSchema(FOLD_SCREEN_COORDINATE_SPACE),
          widthPt: numberSchema(
            'Panel width in native panel points (pixels divided by point scale), NOT snapshot coordinates; take a fresh snapshot to place a tap.',
          ),
          heightPt: numberSchema(
            'Panel height in native panel points (pixels divided by point scale), NOT snapshot coordinates; take a fresh snapshot to place a tap.',
          ),
        },
        ['display', 'coordinateSpace', 'widthPt', 'heightPt'],
      ),
      message: stringSchema(),
    },
    ['action', 'pose', 'hingeAngleDegrees', 'message'],
  ),
  'action-button': objectSchema({ action: constSchema('action-button'), message: stringSchema() }, [
    'action',
    'message',
  ]),
  'tv-remote': objectSchema(
    {
      action: constSchema('tv-remote'),
      button: tvRemoteButtonSchema,
      durationMs: numberSchema(),
      message: stringSchema(),
    },
    ['action', 'button', 'message'],
  ),
  'hardware-button': objectSchema(
    {
      action: constSchema('hardware-button'),
      button: enumSchema(HARDWARE_BUTTON_NAMES),
      message: stringSchema(),
    },
    ['action', 'button', 'message'],
  ),
  // packages/contracts/src/telephony-input.ts — discriminated union on `action`.
  telephony: {
    type: 'object',
    oneOf: [
      objectSchema(
        {
          action: enumSchema(TELEPHONY_CALL_ACTIONS),
          number: stringSchema(),
          message: stringSchema(),
        },
        ['action', 'number', 'message'],
      ),
      objectSchema(
        {
          action: constSchema('sms'),
          number: stringSchema(),
          textLength: numberSchema('Length of the delivered message text.'),
          message: stringSchema(),
        },
        ['action', 'number', 'textLength', 'message'],
      ),
    ],
  },
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
          source: enumSchema(
            ['session', 'runner'],
            'runner when a live runner read the session app state; session when the record alone answered.',
          ),
          state: enumSchema(
            APPLE_APPLICATION_STATES,
            'The session app XCUIApplication state as a live runner reads it; absent with source session.',
          ),
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
          platform: enumSchema(['android', 'harmonyos']),
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
} satisfies Pick<
  Record<keyof CommandResultMap, JsonSchema>,
  | 'back'
  | 'home'
  | 'orientation'
  | 'app-switcher'
  | 'fold'
  | 'action-button'
  | 'tv-remote'
  | 'hardware-button'
  | 'telephony'
  | 'clipboard'
  | 'appstate'
  | 'keyboard'
>;

const appStateCommandDescription =
  'Show foreground app/activity (Android and HarmonyOS; iOS and macOS answer per session)';
const backCommandDescription =
  'Navigate back in the app or through system navigation. Use in-app for the app navigation stack and system when the platform back behavior is required. On iOS, a single-screen iPhone or an iPad whose app provably fills its screen can use a top-leading tap when the app tree is unreadable, with before/after visual verification. A capture failure reports an unknown outcome.';
const homeCommandDescription =
  'Send the selected device to its home screen. This leaves the app session open but moves the foreground away from the app.';
const orientationCommandDescription =
  'Set device orientation on iOS and Android. auto hands rotation back to the sensor on ADB-backed Android (local and Limrun); other backends refuse it. A foldable iPhone simulator (iPhone Duo) refuses portrait-upside-down, and refuses every rotation in a scoped simulator set.';
const foldGuidance = {
  hingeEvent: 'simulator HID hinge event',
  permissions: 'Device Hub and host Accessibility permission are not required.',
} as const;

const foldCommandDescription = `Fold or unfold a foldable iPhone simulator (iPhone Duo) or a foldable Android emulator into the closed, half-open, or open pose. iOS sends a ${foldGuidance.hingeEvent}, then reads the hinge angle back inside the simulator to confirm it, and can follow timestamped angle keyframes; Android sets the emulator console posture, then confirms the device state the guest commits and reports the angle read from the hinge sensor, which can differ from the AVD profile's per-posture angles, and dismisses the lock screen a fold to the cover display can raise. On iOS a pose change moves the app to a different panel with a different point size; on Android a fold to or from closed moves the app between the cover and inner displays, and any pose change can reshape the app window, whose size the next snapshot reports. Either way every ref and coordinate from before it is stale: re-snapshot after this command. Taps, long presses, and scrolling target the app window on its current panel in closed, half-open, and open poses. Simulator and emulator only; iOS requires the iOS simulator SDK; ${foldGuidance.permissions} An iOS simulator in a scoped simulator set folds the same way as one in the default set.`;

const appSwitcherCommandDescription =
  'Open the device app switcher to inspect or change foreground apps. This changes the visible system UI and may move focus away from the current app.';
const keyboardCommandDescription =
  'Inspect Android keyboard visibility/type or press/dismiss the device keyboard. To hide the keyboard, use keyboard dismiss. It taps the keyboard dismiss/hide key when one is exposed, verifies the keyboard closed, and reports UNSUPPORTED_OPERATION when no dismiss key exists \u2014 background taps are never attempted.';
const clipboardCommandDescription =
  'Read the current device clipboard text, or replace its contents with the given text. Android runs both through the clipboard service shell command, and a build that implements none (Android 16 does not) refuses with UNSUPPORTED_OPERATION rather than reporting an empty clipboard.';
const actionButtonCommandDescription =
  'Press the iPhone or iPad Action Button once. The press is dispatched without activating the session app and nothing is re-observed afterwards, so the app keeps the state the press found. What the system does with the press is not observed by this command: Simulators run no Shortcuts or App Intents, so delivery to an assigned Shortcut is verifiable only on a physical iPhone.';
const tvRemoteCommandDescription =
  'Press or long-press a TV remote button on Android TV, tvOS, or Vega OS. Android TV also supports volume, power, media, channel, guide, captions, input, color keys, and android-keycode:N. tvOS and Vega OS support up, down, left, right, select, menu, home, and back. Phones and WebDriver sessions are unsupported. The aliases ok, center, and enter map to select.';

const hardwareButtonCommandDescription =
  'Press a phone hardware button once: volume-up, volume-down, power, mute, sleep, wake, media-play-pause, media-next, media-previous, media-rewind, or media-fast-forward. The press is dispatched without activating the session app and nothing is re-observed afterwards, so the OS decides what the key does — which audio stream a volume press moves, which media session a media key reaches, and whether the HUD shows, is device behavior this command does not claim. Power toggles the Android screen; sleep and wake are the explicit Android events that turn it off or on without toggling, and after a press that turns it off, later commands may hit a locked screen. Android (ADB-backed and Appium) presses all eleven on phones and tablets; a physical iPhone or iPad presses volume only through the local runner or Appium, never power, mute, sleep, wake, or media. iOS Simulators, Android TV and tvOS targets refuse: on TV targets use tv-remote.';

const telephonyCommandDescription =
  'Simulate an incoming phone call or SMS on an Android emulator through its console over adb: call rings from the number, accept answers, cancel ends the call, and sms delivers a text message. The call screen or notification can cover the app, so re-snapshot afterwards.';

const backCommandMetadata = defineFieldCommandMetadata(BACK_COMMAND_NAME, backCommandDescription, {
  mode: enumField(BACK_MODES),
  ...postActionObservationFields(BACK_COMMAND_NAME),
});

const orientationCommandMetadata = defineFieldCommandMetadata(
  ORIENTATION_COMMAND_NAME,
  orientationCommandDescription,
  {
    orientation: requiredField(enumField(ORIENTATION_REQUESTS)),
  },
);

const foldFields = {
  pose: enumField(FOLD_POSES, 'Instant preset; mutually exclusive with keyframes.'),
  keyframes: jsonSchemaField<readonly FoldKeyframe[]>({
    type: 'array',
    minItems: 2,
    maxItems: MAX_FOLD_KEYFRAMES,
    description:
      'Piecewise-linear hinge motion. Start at 0ms; strictly increasing timestamps, up to 60000ms. Repeated angles create holds. Mutually exclusive with pose.',
    items: {
      type: 'object',
      required: ['atMs', 'angle'],
      additionalProperties: false,
      properties: {
        atMs: { type: 'integer', minimum: 0, maximum: MAX_FOLD_DURATION_MS },
        angle: { type: 'number', minimum: 0, maximum: 180 },
      },
    },
  }),
};
const foldFieldMetadata = defineFieldCommandMetadata(
  FOLD_COMMAND_NAME,
  foldCommandDescription,
  foldFields,
  {
    readInput: (input) => {
      const fields = readFieldInput(input, foldFields);
      const { pose, keyframes, ...common } = fields;
      return { ...common, ...parseFoldInput({ pose, keyframes }) };
    },
  },
);

const foldCommandMetadata = {
  ...foldFieldMetadata,
  inputSchema: {
    ...foldFieldMetadata.inputSchema,
    oneOf: [
      { required: ['pose'], not: { required: ['keyframes'] } },
      { required: ['keyframes'], not: { required: ['pose'] } },
    ],
  },
};

const keyboardCommandMetadata = defineFieldCommandMetadata(
  KEYBOARD_COMMAND_NAME,
  keyboardCommandDescription,
  {
    action: enumField(KEYBOARD_METADATA_ACTION_VALUES),
  },
);

// `clipboard read` prints the clipboard content verbatim, so its warnings belong on stderr.
const clipboardCommandMetadata = defineFieldCommandMetadata(
  CLIPBOARD_COMMAND_NAME,
  clipboardCommandDescription,
  {
    action: requiredField(enumField(CLIPBOARD_ACTION_VALUES)),
    text: stringField(),
  },
  { parseableOutput: true },
);

const tvRemoteCommandMetadata = defineFieldCommandMetadata(
  TV_REMOTE_COMMAND_NAME,
  tvRemoteCommandDescription,
  {
    button: requiredField(
      customField<TvRemoteButton>(tvRemoteButtonSchema, (record, key) =>
        parseTvRemoteButton(typeof record[key] === 'string' ? record[key] : undefined),
      ),
    ),
    durationMs: integerField(
      `Press duration in milliseconds. tvOS and Vega OS use the exact hold duration; Android TV maps any positive value to an ADB longpress (${tvRemoteDurationMode('android')}).`,
      {
        min: 0,
      },
    ),
  },
);

const hardwareButtonCommandMetadata = defineFieldCommandMetadata(
  HARDWARE_BUTTON_COMMAND_NAME,
  hardwareButtonCommandDescription,
  {
    button: requiredField(
      enumField(
        HARDWARE_BUTTON_NAMES,
        'One press each. volume-up and volume-down move the system volume stream the OS selects; power toggles the screen on Android; sleep and wake are the explicit Android events that turn the screen off or on without toggling; mute, media-play-pause, media-next, media-previous, media-rewind, and media-fast-forward are Android keys the OS routes to its own streams and media sessions. All of these except volume are refused on every Apple leaf.',
      ),
    ),
  },
);

const telephonyFields = {
  action: requiredField(
    enumField(
      TELEPHONY_ACTIONS,
      'call starts an incoming call, accept answers it, cancel ends it, sms delivers a text message.',
    ),
  ),
  number: requiredField(
    stringField('Caller or sender phone number: digits with an optional leading +.'),
  ),
  text: stringField(
    'Message text for sms; required for sms and refused for the call actions. The emulator drops characters outside the Basic Multilingual Plane, such as emoji.',
  ),
};

const telephonyFieldMetadata = defineFieldCommandMetadata(
  TELEPHONY_COMMAND_NAME,
  telephonyCommandDescription,
  telephonyFields,
  {
    readInput: (input) => {
      const { action, number, text, ...common } = readFieldInput(input, telephonyFields);
      return { ...common, ...parseTelephonyEventInput({ action, number, text }) };
    },
  },
);

const telephonyCommandMetadata = {
  ...telephonyFieldMetadata,
  inputSchema: {
    ...telephonyFieldMetadata.inputSchema,
    oneOf: [
      { properties: { action: constSchema('sms') }, required: ['text'] },
      { properties: { action: enumSchema(TELEPHONY_CALL_ACTIONS) }, not: { required: ['text'] } },
    ],
  },
};

const backCliSchema = {
  usageOverride: 'back [--in-app|--system] [--settle]',
  usageFlags: [],
  allowedFlags: ['backMode', ...postActionObservationCliFlags(BACK_COMMAND_NAME)],
} as const satisfies CommandSchemaOverride;

const orientationCliSchema = {
  usageOverride: `orientation <${ORIENTATION_REQUESTS.join('|')}>`,
  positionalArgs: ['orientation'],
} as const satisfies CommandSchemaOverride;

const foldCliSchema = {
  usageOverride: `fold [${FOLD_POSE_USAGE}]`,
  positionalArgs: ['pose?'],
  allowedFlags: FOLD_FLAGS,
} as const satisfies CommandSchemaOverride;

const keyboardCliSchema = {
  usageOverride: 'keyboard [status|get|dismiss|enter|return]',
  positionalArgs: ['action?'],
} as const satisfies CommandSchemaOverride;

const clipboardCliSchema = {
  usageOverride: 'clipboard read | clipboard write <text>',
  listUsageOverride: 'clipboard read | clipboard write <text>',
  positionalArgs: ['read|write', 'text?'],
  allowsExtraPositionals: true,
} as const satisfies CommandSchemaOverride;

const tvRemoteCliSchema = {
  usageOverride: `tv-remote [press|longpress] ${TV_REMOTE_BUTTON_USAGE}`,
  listUsageOverride: 'tv-remote press|longpress <button> [--duration-ms <ms>]',
  positionalArgs: ['press|longpress?', 'button'],
  allowedFlags: ['durationMs'],
} as const satisfies CommandSchemaOverride;

const hardwareButtonCliSchema = {
  usageOverride: `hardware-button ${HARDWARE_BUTTON_USAGE}`,
  positionalArgs: ['button'],
} as const satisfies CommandSchemaOverride;

const telephonyCliSchema = {
  usageOverride: TELEPHONY_USAGE,
  listUsageOverride: 'telephony call|accept|cancel|sms <number> [text]',
  positionalArgs: ['call|accept|cancel|sms', 'number', 'text?'],
  allowsExtraPositionals: true,
} as const satisfies CommandSchemaOverride;

export const backCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  mode: flags.backMode,
});

export const orientationCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  orientation: parseOrientationRequest(positionals[0]),
});

export const foldCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...parseFoldInput({
    pose: positionals[0],
    keyframes: flags.keyframes === undefined ? undefined : parseFoldKeyframesJson(flags.keyframes),
  }),
});

export const keyboardCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readKeyboardInput(positionals),
});

export const clipboardCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readClipboardInput(positionals),
});

export const tvRemoteCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readTvRemoteInput(positionals, flags.durationMs),
});

export const hardwareButtonCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readHardwareButtonInput(positionals),
});

export const telephonyCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...parseTelephonyPositionals(positionals),
});

export const backDaemonWriter: DaemonWriter = (input) =>
  request(BACK_COMMAND_NAME, [], {
    ...input,
    backMode: readBackMode(input.mode),
  });

export const orientationDaemonWriter: DaemonWriter = direct(ORIENTATION_COMMAND_NAME, (input) => [
  requiredDaemonString(input.orientation, 'orientation requires orientation'),
]);

export const foldDaemonWriter: DaemonWriter = (input) => {
  const fold = parseFoldInput(input);
  return request(FOLD_COMMAND_NAME, fold.pose ? [fold.pose] : [], {
    ...input,
    keyframes: fold.keyframes ? JSON.stringify(fold.keyframes) : undefined,
  });
};

export const keyboardDaemonWriter: DaemonWriter = direct(KEYBOARD_COMMAND_NAME, (input) =>
  optionalString(input.action),
);

export const clipboardDaemonWriter: DaemonWriter = direct(CLIPBOARD_COMMAND_NAME, (input) =>
  clipboardPositionals(input as ClipboardCommandOptions),
);

export const tvRemoteDaemonWriter: DaemonWriter = direct(TV_REMOTE_COMMAND_NAME, (input) => [
  requiredDaemonString(input.button, 'tv-remote requires button'),
]);

export const hardwareButtonDaemonWriter: DaemonWriter = direct(
  HARDWARE_BUTTON_COMMAND_NAME,
  (input) => [requiredDaemonString(input.button, 'hardware-button requires button')],
);

export const telephonyDaemonWriter: DaemonWriter = direct(TELEPHONY_COMMAND_NAME, (input) =>
  telephonyPositionals(parseTelephonyEventInput(input)),
);

const appStateCommandFacet = defineParameterlessCommandFacet({
  name: APPSTATE_COMMAND_NAME,
  description: appStateCommandDescription,
  text: {
    summary: 'Show the foreground app and activity',
  },
  run: (client, input) => client.command.appState(input),
});

const backCommandFacet = defineCommandFacet({
  name: BACK_COMMAND_NAME,
  text: {
    summary: 'Navigate back in the app or system',
  },
  metadata: backCommandMetadata,
  run: (client, input) => client.command.back(input),
  cliSchema: backCliSchema,
  cliReader: backCliReader,
  daemonWriter: backDaemonWriter,
});

const homeCommandFacet = defineParameterlessCommandFacet({
  name: HOME_COMMAND_NAME,
  description: homeCommandDescription,
  text: {
    summary: 'Go to the device home screen',
  },
  run: (client, input) => client.command.home(input),
});

const orientationCommandFacet = defineCommandFacet({
  name: ORIENTATION_COMMAND_NAME,
  text: {
    summary: 'Set device orientation',
  },
  metadata: orientationCommandMetadata,
  run: (client, input) => client.command.orientation(input),
  cliSchema: orientationCliSchema,
  cliReader: orientationCliReader,
  daemonWriter: orientationDaemonWriter,
});

const foldCommandFacet = defineCommandFacet({
  name: FOLD_COMMAND_NAME,
  text: {
    summary: 'Fold or unfold a foldable iPhone simulator or Android emulator',
    cliDetail: `iPhone Duo simulators and foldable Android emulators. iOS sends a ${foldGuidance.hingeEvent} and confirms the hinge angle inside the simulator; Android sets the emulator console posture and confirms the device state. Refs and coordinates do not survive a pose change.`,
  },
  metadata: foldCommandMetadata,
  run: (client, input) => client.command.fold(input),
  cliSchema: foldCliSchema,
  cliReader: foldCliReader,
  daemonWriter: foldDaemonWriter,
});

const appSwitcherCommandFacet = defineParameterlessCommandFacet({
  name: APP_SWITCHER_COMMAND_NAME,
  description: appSwitcherCommandDescription,
  text: {
    summary: 'Open the device app switcher',
  },
  run: (client, input) => client.command.appSwitcher(input),
});

const keyboardCommandFacet = defineCommandFacet({
  name: KEYBOARD_COMMAND_NAME,
  text: {
    summary: 'Inspect, press, or dismiss the device keyboard',
  },
  metadata: keyboardCommandMetadata,
  run: (client, input) => client.command.keyboard(input),
  cliSchema: keyboardCliSchema,
  cliReader: keyboardCliReader,
  daemonWriter: keyboardDaemonWriter,
});

const clipboardCommandFacet = defineCommandFacet({
  name: CLIPBOARD_COMMAND_NAME,
  text: {
    summary: 'Read or write device clipboard text',
  },
  metadata: clipboardCommandMetadata,
  run: (client, input) => client.command.clipboard(input as ClipboardCommandOptions),
  cliSchema: clipboardCliSchema,
  cliReader: clipboardCliReader,
  daemonWriter: clipboardDaemonWriter,
});

const actionButtonCommandFacet = defineParameterlessCommandFacet({
  name: ACTION_BUTTON_COMMAND_NAME,
  description: actionButtonCommandDescription,
  text: {
    summary: 'Press the iPhone or iPad Action Button',
    cliDetail:
      'iPhone and iPad only. The runner asks the device for the button and reports unsupported when that model has none.',
  },
  run: (client, input) => client.command.actionButton(input),
});

const tvRemoteCommandFacet = defineCommandFacet({
  name: TV_REMOTE_COMMAND_NAME,
  text: {
    summary: 'Press a TV remote navigation, media, or hardware button',
    cliDetail:
      'longpress selects the 500ms preset; --duration-ms overrides it. Android TV uses the system long-press duration.',
  },
  metadata: tvRemoteCommandMetadata,
  run: (client, input) => client.command.tvRemote(input),
  cliSchema: tvRemoteCliSchema,
  cliReader: tvRemoteCliReader,
  daemonWriter: tvRemoteDaemonWriter,
});

const hardwareButtonCommandFacet = defineCommandFacet({
  name: HARDWARE_BUTTON_COMMAND_NAME,
  text: {
    summary: 'Press a phone hardware button once',
    cliDetail:
      'Single press; no hold. Android presses all eleven named keys on phones and tablets: volume-up, volume-down, power, mute, sleep, wake, and the five media keys. A physical iPhone or iPad presses volume only; the other keys are never supported on Apple targets. iOS Simulators, Android TV, and tvOS refuse — use tv-remote on TV targets.',
  },
  metadata: hardwareButtonCommandMetadata,
  run: (client, input) => client.command.hardwareButton(input),
  cliSchema: hardwareButtonCliSchema,
  cliReader: hardwareButtonCliReader,
  daemonWriter: hardwareButtonDaemonWriter,
});

const telephonyCommandFacet = defineCommandFacet({
  name: TELEPHONY_COMMAND_NAME,
  text: {
    summary: 'Simulate an incoming call or SMS on an Android emulator over adb',
    cliDetail:
      'Android emulators through the local adb executor; WebDriver (Appium) and Limrun sessions refuse it. Quote the SMS text, or pass it as the remaining words. Re-snapshot after the event: the call screen or notification can cover the app.',
  },
  metadata: telephonyCommandMetadata,
  run: (client, input) => client.command.telephony(input),
  cliSchema: telephonyCliSchema,
  cliReader: telephonyCliReader,
  daemonWriter: telephonyDaemonWriter,
});

export const systemCommandFamily = defineCommandFamilyFromFacets({
  name: 'system',
  commands: [
    appStateCommandFacet,
    backCommandFacet,
    homeCommandFacet,
    orientationCommandFacet,
    foldCommandFacet,
    appSwitcherCommandFacet,
    actionButtonCommandFacet,
    keyboardCommandFacet,
    clipboardCommandFacet,
    tvRemoteCommandFacet,
    hardwareButtonCommandFacet,
    telephonyCommandFacet,
  ],
});

function readBackMode(value: unknown): BackMode | undefined {
  return value === 'in-app' || value === 'system' ? value : undefined;
}

function clipboardPositionals(input: ClipboardCommandOptions): string[] {
  return input.action === 'read' ? ['read'] : ['write', input.text];
}

function readKeyboardInput(positionals: string[]): Record<string, unknown> {
  if (positionals.length > 1) {
    throw new AppError('INVALID_ARGS', 'keyboard accepts at most one action argument.');
  }
  return compactRecord({ action: readKeyboardAction(positionals[0]) });
}

function readClipboardInput(positionals: string[]): Record<string, unknown> {
  const action = positionals[0]?.toLowerCase();
  if (action !== 'read' && action !== 'write') {
    throw new AppError('INVALID_ARGS', 'clipboard requires a subcommand: read or write.');
  }
  if (action === 'read') {
    if (positionals.length !== 1) {
      throw new AppError('INVALID_ARGS', 'clipboard read does not accept additional arguments.');
    }
    return { action };
  }
  if (positionals.length < 2) {
    throw new AppError('INVALID_ARGS', 'clipboard write requires text.');
  }
  return { action, text: positionals.slice(1).join(' ') };
}

function readTvRemoteInput(
  positionals: string[],
  durationMs: number | undefined,
): Record<string, unknown> {
  const subcommand = positionals[0]?.toLowerCase();
  const isNamedAction = subcommand === 'press' || subcommand === 'longpress';
  const args = isNamedAction ? positionals.slice(1) : positionals;
  if (args.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      `tv-remote requires exactly one button: ${TV_REMOTE_BUTTONS.join(', ')}, or android-keycode:<n>.`,
    );
  }
  const effectiveDurationMs =
    durationMs ?? (subcommand === 'longpress' ? TV_REMOTE_LONGPRESS_PRESET_MS : undefined);
  return compactRecord({
    button: parseTvRemoteButton(args[0]),
    durationMs: effectiveDurationMs,
  });
}

function readHardwareButtonInput(positionals: string[]): Record<string, unknown> {
  // One shared helper answers arity and parse for the CLI reader and the daemon resolver alike.
  return { button: HARDWARE_BUTTON_NAME_LABELS[parseHardwareButtonPositionals(positionals)] };
}

function readKeyboardAction(
  value: string | undefined,
): 'status' | 'dismiss' | 'enter' | 'return' | undefined {
  const action = value?.toLowerCase();
  if (action === 'get') return 'status';
  if (
    action === undefined ||
    action === 'status' ||
    action === 'dismiss' ||
    action === 'enter' ||
    action === 'return'
  ) {
    return action;
  }
  throw new AppError(
    'INVALID_ARGS',
    'keyboard action must be status, get, dismiss, enter, or return.',
  );
}
