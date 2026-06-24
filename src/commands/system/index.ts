import type { ClipboardCommandOptions } from '../../client-types.ts';
import type { BackMode } from '../../core/back-mode.ts';
import { BACK_MODES } from '../../core/back-mode.ts';
import { parseDeviceRotation, DEVICE_ROTATIONS } from '../../core/device-rotation.ts';
import { AppError } from '../../utils/errors.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { compactRecord, enumField, requiredField, stringField } from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  optionalString,
  request,
  requiredDaemonString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { systemCliOutputFormatters } from './output.ts';

const APPSTATE_COMMAND_NAME = 'appstate';
const BACK_COMMAND_NAME = 'back';
const HOME_COMMAND_NAME = 'home';
const ROTATE_COMMAND_NAME = 'rotate';
const APP_SWITCHER_COMMAND_NAME = 'app-switcher';
const KEYBOARD_COMMAND_NAME = 'keyboard';
const CLIPBOARD_COMMAND_NAME = 'clipboard';

const CLIPBOARD_ACTION_VALUES = ['read', 'write'] as const;
const KEYBOARD_METADATA_ACTION_VALUES = ['status', 'dismiss'] as const;

const appStateCommandDescription = 'Show foreground app or activity.';
const backCommandDescription = 'Navigate back.';
const homeCommandDescription = 'Go to the home screen.';
const rotateCommandDescription = 'Rotate device orientation.';
const appSwitcherCommandDescription = 'Open the app switcher.';
const keyboardCommandDescription = 'Inspect or dismiss the keyboard.';
const clipboardCommandDescription = 'Read or write clipboard text.';

const appStateCommandMetadata = defineFieldCommandMetadata(
  APPSTATE_COMMAND_NAME,
  appStateCommandDescription,
  {},
);

const backCommandMetadata = defineFieldCommandMetadata(BACK_COMMAND_NAME, backCommandDescription, {
  mode: enumField(BACK_MODES),
});

const homeCommandMetadata = defineFieldCommandMetadata(
  HOME_COMMAND_NAME,
  homeCommandDescription,
  {},
);

const rotateCommandMetadata = defineFieldCommandMetadata(
  ROTATE_COMMAND_NAME,
  rotateCommandDescription,
  {
    orientation: requiredField(enumField(DEVICE_ROTATIONS)),
  },
);

const appSwitcherCommandMetadata = defineFieldCommandMetadata(
  APP_SWITCHER_COMMAND_NAME,
  appSwitcherCommandDescription,
  {},
);

const keyboardCommandMetadata = defineFieldCommandMetadata(
  KEYBOARD_COMMAND_NAME,
  keyboardCommandDescription,
  {
    action: enumField(KEYBOARD_METADATA_ACTION_VALUES),
  },
);

const clipboardCommandMetadata = defineFieldCommandMetadata(
  CLIPBOARD_COMMAND_NAME,
  clipboardCommandDescription,
  {
    action: requiredField(enumField(CLIPBOARD_ACTION_VALUES)),
    text: stringField(),
  },
);

const appStateCommandDefinition = defineExecutableCommand(
  appStateCommandMetadata,
  (client, input) => client.command.appState(input),
);

const backCommandDefinition = defineExecutableCommand(backCommandMetadata, (client, input) =>
  client.command.back(input),
);

const homeCommandDefinition = defineExecutableCommand(homeCommandMetadata, (client, input) =>
  client.command.home(input),
);

const rotateCommandDefinition = defineExecutableCommand(rotateCommandMetadata, (client, input) =>
  client.command.rotate(input),
);

const appSwitcherCommandDefinition = defineExecutableCommand(
  appSwitcherCommandMetadata,
  (client, input) => client.command.appSwitcher(input),
);

const keyboardCommandDefinition = defineExecutableCommand(
  keyboardCommandMetadata,
  (client, input) => client.command.keyboard(input),
);

const clipboardCommandDefinition = defineExecutableCommand(
  clipboardCommandMetadata,
  (client, input) => client.command.clipboard(input as ClipboardCommandOptions),
);

const appStateCliSchema = {
  helpDescription: 'Show foreground app/activity',
} as const satisfies CommandSchemaOverride;

const backCliSchema = {
  usageOverride: 'back [--in-app|--system]',
  allowedFlags: ['backMode'],
} as const satisfies CommandSchemaOverride;

const rotateCliSchema = {
  usageOverride: 'rotate <portrait|portrait-upside-down|landscape-left|landscape-right>',
  helpDescription: 'Rotate device orientation on iOS and Android',
  positionalArgs: ['orientation'],
} as const satisfies CommandSchemaOverride;

const keyboardCliSchema = {
  usageOverride: 'keyboard [status|get|dismiss|enter|return]',
  helpDescription:
    'Inspect Android keyboard visibility/type or press/dismiss the device keyboard. For iOS toolbar Done dismissal, focus the field by id/ref first, then run keyboard dismiss; do not manually press Done unless keyboard dismiss reports unsupported.',
  summary: 'Inspect, press, or dismiss the device keyboard',
  positionalArgs: ['action?'],
} as const satisfies CommandSchemaOverride;

const clipboardCliSchema = {
  usageOverride: 'clipboard read | clipboard write <text>',
  listUsageOverride: 'clipboard read | clipboard write <text>',
  helpDescription: 'Read or write device clipboard text',
  positionalArgs: ['read|write', 'text?'],
  allowsExtraPositionals: true,
} as const satisfies CommandSchemaOverride;

export const appStateCliReader: CliReader = (_positionals, flags) => commonInputFromFlags(flags);
export const homeCliReader: CliReader = (_positionals, flags) => commonInputFromFlags(flags);
export const appSwitcherCliReader: CliReader = (_positionals, flags) => commonInputFromFlags(flags);

export const backCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  mode: flags.backMode,
});

export const rotateCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  orientation: parseDeviceRotation(positionals[0]),
});

export const keyboardCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readKeyboardInput(positionals),
});

export const clipboardCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readClipboardInput(positionals),
});

export const appStateDaemonWriter: DaemonWriter = direct(APPSTATE_COMMAND_NAME);

export const backDaemonWriter: DaemonWriter = (input) =>
  request(BACK_COMMAND_NAME, [], { ...input, backMode: readBackMode(input.mode) });

export const homeDaemonWriter: DaemonWriter = direct(HOME_COMMAND_NAME);

export const rotateDaemonWriter: DaemonWriter = direct(ROTATE_COMMAND_NAME, (input) => [
  requiredDaemonString(input.orientation, 'rotate requires orientation'),
]);

export const appSwitcherDaemonWriter: DaemonWriter = direct(APP_SWITCHER_COMMAND_NAME);

export const keyboardDaemonWriter: DaemonWriter = direct(KEYBOARD_COMMAND_NAME, (input) =>
  optionalString(input.action),
);

export const clipboardDaemonWriter: DaemonWriter = direct(CLIPBOARD_COMMAND_NAME, (input) =>
  clipboardPositionals(input as ClipboardCommandOptions),
);

const appStateCommandFacet = defineCommandFacet({
  name: APPSTATE_COMMAND_NAME,
  metadata: appStateCommandMetadata,
  definition: appStateCommandDefinition,
  cliSchema: appStateCliSchema,
  cliReader: appStateCliReader,
  daemonWriter: appStateDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.appstate,
});

const backCommandFacet = defineCommandFacet({
  name: BACK_COMMAND_NAME,
  metadata: backCommandMetadata,
  definition: backCommandDefinition,
  cliSchema: backCliSchema,
  cliReader: backCliReader,
  daemonWriter: backDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.back,
});

const homeCommandFacet = defineCommandFacet({
  name: HOME_COMMAND_NAME,
  metadata: homeCommandMetadata,
  definition: homeCommandDefinition,
  cliReader: homeCliReader,
  daemonWriter: homeDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.home,
});

const rotateCommandFacet = defineCommandFacet({
  name: ROTATE_COMMAND_NAME,
  metadata: rotateCommandMetadata,
  definition: rotateCommandDefinition,
  cliSchema: rotateCliSchema,
  cliReader: rotateCliReader,
  daemonWriter: rotateDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.rotate,
});

const appSwitcherCommandFacet = defineCommandFacet({
  name: APP_SWITCHER_COMMAND_NAME,
  metadata: appSwitcherCommandMetadata,
  definition: appSwitcherCommandDefinition,
  cliReader: appSwitcherCliReader,
  daemonWriter: appSwitcherDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters['app-switcher'],
});

const keyboardCommandFacet = defineCommandFacet({
  name: KEYBOARD_COMMAND_NAME,
  metadata: keyboardCommandMetadata,
  definition: keyboardCommandDefinition,
  cliSchema: keyboardCliSchema,
  cliReader: keyboardCliReader,
  daemonWriter: keyboardDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.keyboard,
});

const clipboardCommandFacet = defineCommandFacet({
  name: CLIPBOARD_COMMAND_NAME,
  metadata: clipboardCommandMetadata,
  definition: clipboardCommandDefinition,
  cliSchema: clipboardCliSchema,
  cliReader: clipboardCliReader,
  daemonWriter: clipboardDaemonWriter,
  cliOutputFormatter: systemCliOutputFormatters.clipboard,
});

export const systemCommandFamily = defineCommandFamilyFromFacets({
  name: 'system',
  commands: [
    appStateCommandFacet,
    backCommandFacet,
    homeCommandFacet,
    rotateCommandFacet,
    appSwitcherCommandFacet,
    keyboardCommandFacet,
    clipboardCommandFacet,
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
