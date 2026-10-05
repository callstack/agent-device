import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { SettingsUpdateOptions } from '@agent-device/contracts/client';
import {
  APPEARANCE_ACTIONS,
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  parseTextSizeCategory,
  PERMISSION_ACTIONS,
  PERMISSION_MODES,
  SETTINGS_MACOS_PERMISSION_USAGE,
  SETTINGS_USAGE_OVERRIDE,
  type PermissionMode,
} from '@agent-device/contracts/settings';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { readLocationCoordinate } from '@agent-device/kernel/location-coordinates';
import { compactRecord } from '../input-readers.ts';
import { enumField, numberField, requiredField, stringField } from '../command-input.ts';
import {
  isOneOf,
  optionalString,
  request,
  selectionOptionsFromFlags,
  setOf,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';

const SETTINGS_COMMAND_NAME = 'settings';
const settingsCommandDescription =
  'Read or change supported operating-system settings, animation scales, appearance, or app permissions on the selected target. Platform support varies by setting and action.';

const settingsCommandMetadata = defineFieldCommandMetadata(
  SETTINGS_COMMAND_NAME,
  settingsCommandDescription,
  {
    setting: requiredField(stringField()),
    // Optional because a readable setting answers with no state: `settings text-size` asks for the
    // value the target holds. Every other setting still requires one, which the command's own parse
    // and the daemon enforce per setting rather than the shared field map.
    state: stringField(),
    app: stringField(
      'App the change targets, by bundle id or package name: the app `clear-app-state` clears, or the app a `permission` change (or an iOS-simulator `location on|off` privacy change) lands on. An app named here needs no session and need not be running (Android `deny|reset` of a held permission does kill a running one); without it those changes use the session app, and a change that is device-wide refuses one with `setting_app_not_consumed` (`location set` on any target, the Android `location on|off` toggle, macOS permissions). The CLI consumes it only when this invocation passes it: an `AGENT_DEVICE_TARGET_APP` or config `targetApp` never retargets a settings mutation.',
    ),
    latitude: numberField(),
    longitude: numberField(),
    permission: stringField(),
    mode: enumField([...PERMISSION_MODES]),
  },
);

const settingsCliSchema = {
  usageOverride: SETTINGS_USAGE_OVERRIDE,
  listUsageOverride: 'settings [area] [options]',
  positionalArgs: ['setting', 'state?', 'target?', 'mode?'],
  // `--app` names the app an app-scoped change lands on (`settings permission grant camera --app
  // com.example.app`), shared with `doctor`. It rides the request's input payload, not a positional,
  // because the setting's own positionals already carry the permission target and mode.
  allowedFlags: ['targetApp'],
  // A settings mutation changes state on the app it resolves, so the app must come only from this
  // invocation: `doctor` reads `--app` to check someone's default app, and the same env or config
  // key must never redirect a `grant` or a destructive `clear-app-state` away from the session app.
  explicitOnlyFlags: ['targetApp'],
} as const satisfies CommandSchemaOverride;

export const settingsCliReader: CliReader = (positionals, flags) => {
  const options = readSettingsOptionsFromPositionals(positionals, flags);
  // `clear-app-state` already names its app positionally, so `--app` fills the slot only for the
  // settings whose app has no positional. Whether a mutation can consume an app at all is the
  // daemon's scope table to decide once it knows the resolved target.
  return options.setting === 'clear-app-state' || flags.targetApp === undefined
    ? options
    : { ...options, app: flags.targetApp };
};

export const settingsDaemonWriter: DaemonWriter = (input) => {
  const options = input as SettingsUpdateOptions;
  // The app-scoped `app` has no positional of its own and `app` is no CLI flag key, so it crosses
  // the daemon boundary as request input the way a gesture payload does: read back by the handler,
  // never reconstructed from the command line. `clear-app-state` keeps carrying its app
  // positionally, as it always has.
  const settingsInput = compactRecord({ app: settingsInputApp(options) });
  return request(
    PUBLIC_COMMANDS.settings,
    settingsPositionals(options),
    input,
    Object.keys(settingsInput).length === 0 ? undefined : settingsInput,
  );
};

/** The settings whose `app` reaches the daemon through request input rather than a positional. */
function settingsInputApp(input: SettingsUpdateOptions): string | undefined {
  if (input.setting === 'permission') return input.app;
  // Every location state forwards the app: `on|off` consumes it on Apple, and `set` is device-wide
  // for everyone, so the daemon's scope table refuses the named app instead of the writer dropping
  // it without a word.
  if (input.setting === 'location') return input.app;
  return undefined;
}

export const settingsCommandFacet = defineCommandFacet({
  name: SETTINGS_COMMAND_NAME,
  text: {
    summary: 'Change OS settings and app permissions',
    cliDetail: `macOS supports only settings appearance <light|dark|toggle> and settings ${SETTINGS_MACOS_PERMISSION_USAGE}; wifi|airplane|location|animations|text-size remain unsupported on macOS. Mobile permission actions default to the active session app; pass --app <id> (or the app input) to aim a permission change, or an iOS-simulator location on|off, at an installed app no session has opened; no app needs to be running, and the CLI consumes the app only when this invocation names it, never from AGENT_DEVICE_TARGET_APP or config targetApp. A device-wide change refuses an app with setting_app_not_consumed: location set moves the device's own coordinates on every target, the Android location toggle writes the device's location_mode, and a macOS permission is a host-level TCC grant. On Android, deny|reset of a permission the app currently holds kills a running app; the response reports priorGrantState (granted|not_granted|unknown) and warns for granted and unknown, with open <app> --relaunch to restore it. Permission changes require a resolvable foreground user and fail without mutating if adb cannot report one. Android settings airplane on|off is applied by the connectivity service (Android 11+) and reports the airplaneMode that service holds; older builds fail without changing device state. settings reset-keychain clear is iOS-simulator-only and resets the whole simulator keychain, not just the selected app: simctl exposes no per-app keychain reset, so every app on that simulator loses its keychain-backed credentials (e.g. Firebase auth). clear-app-state does not touch the keychain, so a full fresh-install reset needs both; relaunch the app afterward to observe the signed-out state. settings text-size reads the preferred text size the target holds and settings text-size <category> applies one, on iPhone and iPad simulators (simctl content size) and on Android targets (system font_scale); tvOS and visionOS simulators, physical Apple devices, and the macOS host refuse it. Android has no category ladder of its own, so the read names the nearest rung and reports the exact multiplier as platformValue; an already-running app adopts a changed size at its next configuration change, so relaunch the app under test to observe it.`,
  },
  metadata: settingsCommandMetadata,
  run: (client, input) => client.settings.update(input as SettingsUpdateOptions),
  cliSchema: settingsCliSchema,
  cliReader: settingsCliReader,
  daemonWriter: settingsDaemonWriter,
  // Android permission revokes append a relaunch warning (#1796); render it for humans too.
  cliOutputFormatter: messageOutput,
});

// fallow-ignore-next-line complexity
function readSettingsOptionsFromPositionals(
  positionals: string[],
  flags: CliFlags,
): SettingsUpdateOptions {
  const base = selectionOptionsFromFlags(flags);
  const setting = positionals[0];
  const state = positionals[1];
  if (isOneOf(setting, ON_OFF_SETTINGS) && isOneOf(state, ON_OFF_STATES)) {
    return { ...base, setting, state };
  }
  if (setting === 'location' && state === 'set') {
    return {
      ...base,
      setting,
      state,
      latitude: readLocationCoordinate(positionals[2], 'latitude'),
      longitude: readLocationCoordinate(positionals[3], 'longitude'),
    };
  }
  if (setting === 'appearance' && isOneOf(state, APPEARANCE_STATES)) {
    return { ...base, setting, state };
  }
  // A bare `settings text-size` reads the category the target holds; a category applies it. The
  // category is parsed here rather than handed to the tool, which answers an unknown one with
  // success, and the refusal lists the whole ladder.
  if (setting === 'text-size') {
    return state === undefined
      ? { ...base, setting }
      : { ...base, setting, state: parseTextSizeCategory(state) };
  }
  if (isOneOf(setting, BIOMETRIC_SETTINGS) && isOneOf(state, BIOMETRIC_STATES)) {
    return { ...base, setting, state };
  }
  if (setting === 'fingerprint' && isOneOf(state, FINGERPRINT_STATES)) {
    return { ...base, setting, state };
  }
  if (setting === 'permission' && isOneOf(state, PERMISSION_STATES)) {
    return {
      ...base,
      setting,
      state,
      permission: readPermission(positionals[2]),
      mode: readPermissionMode(positionals[3]),
    };
  }
  if (setting === 'clear-app-state') {
    const app = state === 'clear' ? positionals[2] : state;
    return { ...base, setting, state: 'clear', app };
  }
  if (setting === 'reset-keychain' && state === 'clear' && positionals.length === 2) {
    return { ...base, setting, state };
  }
  throw new AppError('INVALID_ARGS', 'Invalid settings arguments.');
}

function settingsPositionals(input: SettingsUpdateOptions): string[] {
  if (input.setting === 'clear-app-state') {
    return [input.setting, ...optionalString(input.app)];
  }
  // No state is the read leg: the daemon admits the owner's read fact for a lone positional.
  if (input.setting === 'text-size') {
    return [input.setting, ...optionalString(input.state)];
  }
  if (input.setting === 'location' && input.state === 'set') {
    return [input.setting, input.state, String(input.latitude), String(input.longitude)];
  }
  if (input.setting === 'permission') {
    return [input.setting, input.state, input.permission, ...optionalString(input.mode)];
  }
  return [input.setting, input.state];
}

function readPermission(value: string | undefined): PermissionTarget {
  if (isOneOf(value, PERMISSION_TARGETS)) return value;
  throw new AppError('INVALID_ARGS', 'settings permission requires a permission target.');
}

function readPermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined || isOneOf(value, PERMISSION_MODE_VALUES)) return value;
  throw new AppError('INVALID_ARGS', 'settings permission mode must be full or limited.');
}

type PermissionTarget = Extract<SettingsUpdateOptions, { setting: 'permission' }>['permission'];
type OnOffSetting = Extract<SettingsUpdateOptions, { state: 'on' | 'off' }>['setting'];
type OnOffState = Extract<SettingsUpdateOptions, { state: 'on' | 'off' }>['state'];
type BiometricSetting = Extract<
  SettingsUpdateOptions,
  { setting: 'faceid' | 'touchid' }
>['setting'];
type BiometricState = Extract<SettingsUpdateOptions, { setting: 'faceid' | 'touchid' }>['state'];
type FingerprintState = Extract<SettingsUpdateOptions, { setting: 'fingerprint' }>['state'];
type AppearanceState = Extract<SettingsUpdateOptions, { setting: 'appearance' }>['state'];

const ON_OFF_SETTINGS = setOf<OnOffSetting>('wifi', 'airplane', 'location', 'animations');
const ON_OFF_STATES = setOf<OnOffState>('on', 'off');
const APPEARANCE_STATES = setOf<AppearanceState>(...APPEARANCE_ACTIONS);
const BIOMETRIC_SETTINGS = setOf<BiometricSetting>('faceid', 'touchid');
const BIOMETRIC_STATES = setOf<BiometricState>('match', 'nonmatch', 'enroll', 'unenroll');
const FINGERPRINT_STATES = setOf<FingerprintState>('match', 'nonmatch');
const PERMISSION_MODE_VALUES = setOf(...PERMISSION_MODES);
const PERMISSION_STATES = setOf(...PERMISSION_ACTIONS);
const PERMISSION_TARGETS = setOf(...MOBILE_PERMISSION_TARGETS, ...MACOS_PERMISSION_TARGETS);
