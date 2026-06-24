import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AppCloseOptions } from '../../client-types.ts';
import { DEFAULT_APPS_FILTER } from '../../contracts/app-inventory.ts';
import { SESSION_SURFACES } from '../../core/session-surface.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { assertResolvedAppsFilter } from './app-inventory-contract.ts';
import {
  booleanField,
  booleanSchema,
  enumField,
  jsonSchemaField,
  stringArrayField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, CommandInput, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const appsCommandMetadata = defineFieldCommandMetadata('apps', 'List installed apps.', {
  appsFilter: enumField(['user-installed', 'all']),
});

const openCommandMetadata = defineFieldCommandMetadata(
  'open',
  'Open an app, deep link, URL, or platform surface.',
  {
    app: stringField('App name, bundle id, package, or URL.'),
    url: stringField('Optional URL passed with an app shell.'),
    surface: enumField(SESSION_SURFACES),
    activity: stringField('Android activity name.'),
    launchConsole: stringField('Launch console mode.'),
    launchArgs: stringArrayField(
      'Launch arguments forwarded verbatim to the platform launch command.',
    ),
    relaunch: booleanField('Force relaunch.'),
    saveScript: jsonSchemaField<boolean | string>({ oneOf: [booleanSchema(), stringSchema()] }),
    deviceHub: booleanField('Use Xcode Device Hub when surfacing Apple simulators.'),
    noRecord: booleanField('Do not record this action.'),
  },
);

const closeCommandMetadata = defineFieldCommandMetadata(
  'close',
  'Close an app or end the active session.',
  {
    app: stringField('Optional app to close.'),
    shutdown: booleanField('Shutdown the session/device where supported.'),
    saveScript: jsonSchemaField<boolean | string>({ oneOf: [booleanSchema(), stringSchema()] }),
  },
);

const appsCommandDefinition = defineExecutableCommand(appsCommandMetadata, (client, input) =>
  client.apps.list(input),
);

const openCommandDefinition = defineExecutableCommand(openCommandMetadata, (client, input) =>
  client.apps.open(input),
);

const closeCommandDefinition = defineExecutableCommand(closeCommandMetadata, (client, input) =>
  input.app ? client.apps.close(input) : client.sessions.close(withoutApp(input)),
);

const appsCliSchema = {
  helpDescription: 'List user-installed apps; use --all to include system/OEM apps',
  summary: 'List installed apps',
  allowedFlags: ['appsFilter'],
  defaults: { appsFilter: DEFAULT_APPS_FILTER },
} as const satisfies CommandSchemaOverride;

const openCliSchema = {
  helpDescription:
    'Boot device/simulator; optionally launch app or deep link URL. Use --platform to bind URL/deep-link opens to the target platform. For iOS simulator initial stdout/stderr, put --launch-console <path> on this open command, for example agent-device open "Agent Device Tester" --platform ios --launch-console artifacts/launch-console.log. Expo Go/dev-client shells accept host + URL, for example agent-device open "Expo Go" exp://127.0.0.1:8081 --platform ios. macOS also supports --surface app|frontmost-app|desktop|menubar.',
  summary: 'Open an app, deep link or URL, save replays',
  positionalArgs: ['appOrUrl?', 'url?'],
  allowedFlags: [
    'activity',
    'launchConsole',
    'launchArgs',
    'deviceHub',
    'saveScript',
    'noRecord',
    'relaunch',
    'surface',
  ],
} as const satisfies CommandSchemaOverride;

const closeCliSchema = {
  positionalArgs: ['app?'],
  allowedFlags: ['saveScript', 'shutdown'],
} as const satisfies CommandSchemaOverride;

const appsCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  appsFilter: assertResolvedAppsFilter(flags.appsFilter),
});

const openCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: positionals[0],
  url: positionals[1],
  surface: flags.surface,
  activity: flags.activity,
  launchConsole: flags.launchConsole,
  launchArgs: flags.launchArgs,
  relaunch: flags.relaunch,
  saveScript: flags.saveScript,
  deviceHub: flags.deviceHub,
  noRecord: flags.noRecord,
});

const closeCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: positionals[0],
  shutdown: flags.shutdown,
  saveScript: flags.saveScript,
});

const appsDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.apps);
const openDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.open, openPositionals);
const closeDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.close, (input) =>
  optionalString(input.app),
);

export const appsCommandFacet = defineCommandFacet({
  name: 'apps',
  metadata: appsCommandMetadata,
  definition: appsCommandDefinition,
  cliSchema: appsCliSchema,
  cliReader: appsCliReader,
  daemonWriter: appsDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.apps,
});

export const openCommandFacet = defineCommandFacet({
  name: 'open',
  metadata: openCommandMetadata,
  definition: openCommandDefinition,
  cliSchema: openCliSchema,
  cliReader: openCliReader,
  daemonWriter: openDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.open,
});

export const closeCommandFacet = defineCommandFacet({
  name: 'close',
  metadata: closeCommandMetadata,
  definition: closeCommandDefinition,
  cliSchema: closeCliSchema,
  cliReader: closeCliReader,
  daemonWriter: closeDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.close,
});

function withoutApp(input: AppCloseOptions & { shutdown?: boolean }): { shutdown?: boolean } {
  const { app: _app, ...rest } = input;
  return rest;
}

function openPositionals(input: CommandInput): string[] {
  if (!input.app) return [];
  return input.url ? [input.app, input.url] : [input.app];
}
