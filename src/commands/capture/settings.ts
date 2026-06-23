import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { SettingsUpdateOptions } from '../../client-types.ts';
import { SETTINGS_USAGE_OVERRIDE } from '../../core/settings-contract.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import { AppError } from '../../utils/errors.ts';
import { readLocationCoordinate } from '../../utils/location-coordinates.ts';
import { defineExecutableCommand } from '../command-contract.ts';
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

const SETTINGS_COMMAND_NAME = 'settings';
const settingsCommandDescription = 'Change OS settings and app permissions.';

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
    mode: enumField(['full', 'limited']),
  },
);

const settingsCommandDefinition = defineExecutableCommand(
  settingsCommandMetadata,
  (client, input) => client.settings.update(input as SettingsUpdateOptions),
);

const settingsCliSchema = {
  usageOverride: SETTINGS_USAGE_OVERRIDE,
  listUsageOverride: 'settings [area] [options]',
  helpDescription:
    'Toggle OS settings, animation scales, appearance, and app permissions (macOS supports only settings appearance <light|dark|toggle> and settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>; wifi|airplane|location|animations remain unsupported on macOS; mobile permission actions use the active session app)',
  summary: 'Change OS settings and app permissions',
  positionalArgs: ['setting', 'state', 'target?', 'mode?'],
} as const satisfies CommandSchemaOverride;

export const settingsCliReader: CliReader = (positionals, flags) =>
  readSettingsOptionsFromPositionals(positionals, flags);

export const settingsDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.settings, (input) =>
  settingsPositionals(input as SettingsUpdateOptions),
);

export const settingsCommandFacet = defineCommandFacet({
  name: SETTINGS_COMMAND_NAME,
  metadata: settingsCommandMetadata,
  definition: settingsCommandDefinition,
  cliSchema: settingsCliSchema,
  cliReader: settingsCliReader,
  daemonWriter: settingsDaemonWriter,
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

function readPermissionMode(value: string | undefined): 'full' | 'limited' | undefined {
  if (value === undefined || value === 'full' || value === 'limited') return value;
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
type PermissionState = Extract<SettingsUpdateOptions, { setting: 'permission' }>['state'];

const ON_OFF_SETTINGS = setOf<OnOffSetting>('wifi', 'airplane', 'location', 'animations');
const ON_OFF_STATES = setOf<OnOffState>('on', 'off');
const APPEARANCE_STATES = setOf<AppearanceState>('light', 'dark', 'toggle');
const BIOMETRIC_SETTINGS = setOf<BiometricSetting>('faceid', 'touchid');
const BIOMETRIC_STATES = setOf<BiometricState>('match', 'nonmatch', 'enroll', 'unenroll');
const FINGERPRINT_STATES = setOf<FingerprintState>('match', 'nonmatch');
const PERMISSION_STATES = setOf<PermissionState>('grant', 'deny', 'reset');
const PERMISSION_TARGETS = setOf<PermissionTarget>(
  'camera',
  'microphone',
  'photos',
  'contacts',
  'contacts-limited',
  'notifications',
  'calendar',
  'location',
  'location-always',
  'media-library',
  'motion',
  'reminders',
  'siri',
  'accessibility',
  'screen-recording',
  'input-monitoring',
);
