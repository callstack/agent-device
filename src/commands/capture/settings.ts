import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { SettingsUpdateOptions } from '@agent-device/contracts/client';
import {
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
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
import { enumField, numberField, requiredField, stringField } from '../command-input.ts';
import {
  direct,
  isOneOf,
  optionalString,
  selectionOptionsFromFlags,
  setOf,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';

const SETTINGS_COMMAND_NAME = 'settings';
const settingsCommandDescription =
  'Change supported operating-system settings, animation scales, appearance, or app permissions on the selected target. Platform support varies by setting and action.';

const settingsCommandMetadata = defineFieldCommandMetadata(
  SETTINGS_COMMAND_NAME,
  settingsCommandDescription,
  {
    setting: requiredField(stringField()),
    state: requiredField(stringField()),
    app: stringField(),
    latitude: numberField(),
    longitude: numberField(),
    permission: stringField(),
    mode: enumField([...PERMISSION_MODES]),
  },
);

const settingsCliSchema = {
  usageOverride: SETTINGS_USAGE_OVERRIDE,
  listUsageOverride: 'settings [area] [options]',
  positionalArgs: ['setting', 'state', 'target?', 'mode?'],
} as const satisfies CommandSchemaOverride;

export const settingsCliReader: CliReader = (positionals, flags) =>
  readSettingsOptionsFromPositionals(positionals, flags);

export const settingsDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.settings, (input) =>
  settingsPositionals(input as SettingsUpdateOptions),
);

export const settingsCommandFacet = defineCommandFacet({
  name: SETTINGS_COMMAND_NAME,
  text: {
    summary: 'Change OS settings and app permissions',
    cliDetail: `macOS supports only settings appearance <light|dark|toggle> and settings ${SETTINGS_MACOS_PERMISSION_USAGE}; wifi|airplane|location|animations remain unsupported on macOS. Mobile permission actions use the active session app. On Android, deny|reset of a permission the app currently holds kills a running app; the response reports priorGrantState (granted|not_granted|unknown) and warns for granted and unknown, with open <app> --relaunch to restore it. Permission changes require a resolvable foreground user and fail without mutating if adb cannot report one. Android settings airplane on|off is applied by the connectivity service (Android 11+) and reports the airplaneMode that service holds; older builds fail without changing device state. settings reset-keychain clear is iOS-simulator-only and resets the whole simulator keychain, not just the selected app: simctl exposes no per-app keychain reset, so every app on that simulator loses its keychain-backed credentials (e.g. Firebase auth). clear-app-state does not touch the keychain, so a full fresh-install reset needs both; relaunch the app afterward to observe the signed-out state.`,
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
const APPEARANCE_STATES = setOf<AppearanceState>('light', 'dark', 'toggle');
const BIOMETRIC_SETTINGS = setOf<BiometricSetting>('faceid', 'touchid');
const BIOMETRIC_STATES = setOf<BiometricState>('match', 'nonmatch', 'enroll', 'unenroll');
const FINGERPRINT_STATES = setOf<FingerprintState>('match', 'nonmatch');
const PERMISSION_MODE_VALUES = setOf(...PERMISSION_MODES);
const PERMISSION_STATES = setOf(...PERMISSION_ACTIONS);
const PERMISSION_TARGETS = setOf(...MOBILE_PERMISSION_TARGETS, ...MACOS_PERMISSION_TARGETS);
