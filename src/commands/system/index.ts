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
  DEVICE_ROTATIONS,
  FOLD_POSES,
  FOLD_POSE_USAGE,
  parseDeviceRotation,
} from '@agent-device/contracts/device';
import { type BackMode, BACK_MODES } from '@agent-device/contracts/back-mode';
import {
  TV_REMOTE_BUTTONS,
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
import { systemCliOutputFormatters } from './output.ts';

const APPSTATE_COMMAND_NAME = 'appstate';
const BACK_COMMAND_NAME = 'back';
const HOME_COMMAND_NAME = 'home';
const ORIENTATION_COMMAND_NAME = 'orientation';
const FOLD_COMMAND_NAME = 'fold';
const APP_SWITCHER_COMMAND_NAME = 'app-switcher';
const ACTION_BUTTON_COMMAND_NAME = 'action-button';
const KEYBOARD_COMMAND_NAME = 'keyboard';
const CLIPBOARD_COMMAND_NAME = 'clipboard';
const TV_REMOTE_COMMAND_NAME = 'tv-remote';
const TV_REMOTE_LONGPRESS_PRESET_MS = 500;

const CLIPBOARD_ACTION_VALUES = ['read', 'write'] as const;
const KEYBOARD_METADATA_ACTION_VALUES = ['status', 'dismiss', 'enter', 'return'] as const;

/**
 * This family's advertised MCP `outputSchema`s, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
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
      orientation: enumSchema(DEVICE_ROTATIONS),
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
      hingeAngleDegrees: numberSchema('Hinge angle CoreDevice read back after the pose settled.'),
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
      button: enumSchema(TV_REMOTE_BUTTONS),
      durationMs: numberSchema(),
      message: stringSchema(),
    },
    ['action', 'button', 'message'],
  ),
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
          platform: constSchema('android'),
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
  | 'clipboard'
  | 'appstate'
  | 'keyboard'
>;

const appStateCommandDescription =
  'Show foreground app/activity (Android; iOS answers per command)';
const backCommandDescription =
  'Navigate back in the app or through system navigation. Use in-app for the app navigation stack and system when the platform back behavior is required.';
const homeCommandDescription =
  'Send the selected device to its home screen. This leaves the app session open but moves the foreground away from the app.';
const orientationCommandDescription = 'Set device orientation on iOS and Android';
const foldGuidance = {
  hingeEvent: 'simulator HID hinge event',
  permissions: 'Device Hub and host Accessibility permission are not required.',
  unsupportedScope: 'UNSUPPORTED_OPERATION and reason unsupported-device-scope',
} as const;

const foldCommandDescription = `Fold or unfold a foldable iPhone simulator (iPhone Duo) into the closed, half-open, or open pose, or follow timestamped angle keyframes, by sending a ${foldGuidance.hingeEvent}, then read the hinge angle back from CoreDevice to confirm it. A pose change moves the app to a different panel with a different point size, so every ref and coordinate from before it is stale: re-snapshot after this command. Taps, long presses, and scrolling target the app window on its current panel in closed, half-open, and open poses. Simulator-only; requires the iOS simulator SDK; ${foldGuidance.permissions} A simulator scoped to a non-default simulator set is refused with ${foldGuidance.unsupportedScope}; run fold against a simulator in the default set.`;

export const foldableHelpTopic = {
  summary: 'Foldable Apple devices: panels, pose, and which screen you are on',
  body: `agent-device help foldable

A foldable Apple device (iPhone Duo) carries two integrated panels, which Apple calls the outer display and the inner display. Only one is lit at a time, and which one is lit is the device pose.

Screens are handled for you:
  Each iOS simulator capture resolves the CoreDevice display table, captures the lit panel explicitly, and normalizes density with that panel's own point scale. Do not add a screen flag to the normal loop; there is none, because the lit panel is always the only capturable one: the dark panel yields an all-black PNG.
  The two panels are different sizes (iPhone Duo: 466x678 points closed on the outer panel, 669x951 open on the inner). A pose change therefore invalidates every ref and coordinate. Re-snapshot after any pose change and never carry coordinates or refs across one.
  Check which panel is lit before trusting a geometry claim: agent-device screenshot reports its point size, and 466x678 versus 669x951 says which panel you captured.

Changing the pose:
  agent-device fold closed | half-open | open
  fold sends a private HID hinge event inside the selected simulator and then reads the hinge angle back from CoreDevice until it agrees: closed is 0 degrees, open is 180, and half-open is any angle between them (requested at 130 degrees). An angle in that interval only proves the category, so half-open is reported once two consecutive readings both fall inside it and agree within 0.5 degrees. The response reports the verified pose, the hinge angle, and the panel the device now lights with its native panel point size, marked coordinateSpace "native-panel". That point size is the panel's own geometry, not the next snapshot's viewport, so it cannot place a tap: the active app window can differ (a 669x951 inner panel hosts a 951x669 window). A hinge whose last reading is some other pose fails with COMMAND_FAILED and reason fold-pose-unverified, naming the angle CoreDevice still reports; a hinge seen half-open but never at rest fails with reason fold-pose-unsettled, naming the observed and previous angles. A single-panel simulator fails with UNSUPPORTED_OPERATION. A simulator scoped to a non-default set with --ios-simulator-device-set is refused before any hinge is touched, with ${foldGuidance.unsupportedScope}: the HID send honors the set, but CoreDevice's display inventory and hinge-angle readback resolve a scoped simulator as not found, so the pose could not be verified. Run fold without --ios-simulator-device-set (in the default set).
  Expect a fold to take 10-16 seconds: each hinge read is a five-second devicectl stream, and half-open waits for the hinge to stop moving. Re-snapshot after every fold; refs and coordinates from before it are stale, and the command's message says so.
  Timed motion: fold --keyframes '[{"atMs":0,"angle":0},{"atMs":5000,"angle":180}]'. Use 2–64 frames starting at 0ms, increasing integer timestamps up to 60000ms, and angles from 0 to 180. The last timestamp sets motion duration, excluding setup and verification. Equal angles hold; cancellation stops motion. See the fold examples in the command and Node API documentation for trajectories.

  Requirements: an iOS simulator session on a foldable device and an Xcode toolchain with the iOS simulator SDK and foldable HID support (verified on Xcode 27.1). ${foldGuidance.permissions} The command runs a small helper through simctl spawn for the session UDID; the helper is built once per Fold.m source hash and Xcode toolchain, cached under ~/.agent-device/fold-helper, and rebuilt only when the source or the toolchain changes. Build or dispatch failures are reported without a UI fallback. The app under test reads the resulting pose as UIHinge.status.
  If a task asserts behavior for more than one pose, fold to each pose and re-snapshot, and report which poses the run covered.`,
} as const;

const appSwitcherCommandDescription =
  'Open the device app switcher to inspect or change foreground apps. This changes the visible system UI and may move focus away from the current app.';
const keyboardCommandDescription =
  'Inspect Android keyboard visibility/type or press/dismiss the device keyboard. To hide the keyboard, use keyboard dismiss. It taps the keyboard dismiss/hide key when one is exposed, verifies the keyboard closed, and reports UNSUPPORTED_OPERATION when no dismiss key exists \u2014 background taps are never attempted.';
const clipboardCommandDescription =
  'Read the current device clipboard text, or replace its contents with the given text. Android runs both through the clipboard service shell command, and a build that implements none (Android 16 does not) refuses with UNSUPPORTED_OPERATION rather than reporting an empty clipboard.';
const actionButtonCommandDescription =
  'Press the iPhone or iPad Action Button once. The press is dispatched without activating the session app and nothing is re-observed afterwards, so the app keeps the state the press found. What the system does with the press is not observed by this command: Simulators run no Shortcuts or App Intents, so delivery to an assigned Shortcut is verifiable only on a physical iPhone.';
const tvRemoteCommandDescription =
  'Press or long-press a TV remote or D-pad button on Android TV, tvOS, or Vega OS. Choose the button and optional hold duration through the input fields. The aliases ok, center, and enter all map to select.';

const backCommandMetadata = defineFieldCommandMetadata(BACK_COMMAND_NAME, backCommandDescription, {
  mode: enumField(BACK_MODES),
  ...postActionObservationFields(BACK_COMMAND_NAME),
});

const orientationCommandMetadata = defineFieldCommandMetadata(
  ORIENTATION_COMMAND_NAME,
  orientationCommandDescription,
  {
    orientation: requiredField(enumField(DEVICE_ROTATIONS)),
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
    button: requiredField(enumField(TV_REMOTE_BUTTONS)),
    durationMs: integerField(
      `Press duration in milliseconds. tvOS and Vega OS use the exact hold duration; Android TV maps any positive value to an ADB longpress (${tvRemoteDurationMode('android')}).`,
      {
        min: 0,
      },
    ),
  },
);

const backCliSchema = {
  usageOverride: 'back [--in-app|--system] [--settle]',
  usageFlags: [],
  allowedFlags: ['backMode', ...postActionObservationCliFlags(BACK_COMMAND_NAME)],
} as const satisfies CommandSchemaOverride;

const orientationCliSchema = {
  usageOverride: 'orientation <portrait|portrait-upside-down|landscape-left|landscape-right>',
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

export const backCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  mode: flags.backMode,
});

export const orientationCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  orientation: parseDeviceRotation(positionals[0]),
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

const appStateCommandFacet = defineParameterlessCommandFacet({
  name: APPSTATE_COMMAND_NAME,
  description: appStateCommandDescription,
  text: {
    summary: 'Show the foreground app and activity',
  },
  run: (client, input) => client.command.appState(input),
  cliOutputFormatter: systemCliOutputFormatters.appstate,
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
  cliOutputFormatter: systemCliOutputFormatters.back,
});

const homeCommandFacet = defineParameterlessCommandFacet({
  name: HOME_COMMAND_NAME,
  description: homeCommandDescription,
  text: {
    summary: 'Go to the device home screen',
  },
  run: (client, input) => client.command.home(input),
  cliOutputFormatter: systemCliOutputFormatters.home,
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
  cliOutputFormatter: systemCliOutputFormatters.orientation,
});

const foldCommandFacet = defineCommandFacet({
  name: FOLD_COMMAND_NAME,
  text: {
    summary: 'Fold or unfold a foldable iPhone simulator',
    cliDetail: `iPhone Duo simulators only. Sends a ${foldGuidance.hingeEvent} and confirms the hinge angle through CoreDevice; refs and coordinates do not survive a pose change.`,
  },
  metadata: foldCommandMetadata,
  run: (client, input) => client.command.fold(input),
  cliSchema: foldCliSchema,
  cliReader: foldCliReader,
  daemonWriter: foldDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.fold,
});

const appSwitcherCommandFacet = defineParameterlessCommandFacet({
  name: APP_SWITCHER_COMMAND_NAME,
  description: appSwitcherCommandDescription,
  text: {
    summary: 'Open the device app switcher',
  },
  run: (client, input) => client.command.appSwitcher(input),
  cliOutputFormatter: systemCliOutputFormatters['app-switcher'],
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
  cliOutputFormatter: systemCliOutputFormatters.keyboard,
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
  cliOutputFormatter: systemCliOutputFormatters.clipboard,
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
  cliOutputFormatter: systemCliOutputFormatters['action-button'],
});

const tvRemoteCommandFacet = defineCommandFacet({
  name: TV_REMOTE_COMMAND_NAME,
  text: {
    summary: 'Press a TV remote/D-pad button',
    cliDetail: 'longpress holds for 500ms by default; --duration-ms overrides the preset.',
  },
  metadata: tvRemoteCommandMetadata,
  run: (client, input) => client.command.tvRemote(input),
  cliSchema: tvRemoteCliSchema,
  cliReader: tvRemoteCliReader,
  daemonWriter: tvRemoteDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters['tv-remote'],
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
      `tv-remote requires exactly one button: ${TV_REMOTE_BUTTONS.join(', ')}.`,
    );
  }
  const effectiveDurationMs =
    durationMs ?? (subcommand === 'longpress' ? TV_REMOTE_LONGPRESS_PRESET_MS : undefined);
  return compactRecord({
    button: parseTvRemoteButton(args[0]),
    durationMs: effectiveDurationMs,
  });
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
