import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type {
  AppCloseOptions,
  AppPushOptions,
  AppTriggerEventOptions,
} from '../../client-types.ts';
import type { DaemonInstallSource } from '../../contracts.ts';
import { SESSION_SURFACES } from '../../core/session-surface.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { AppError } from '../../utils/errors.ts';
import { parseGitHubActionsArtifactInstallSourceSpec } from '../../utils/install-source-config.ts';
import { assertResolvedAppsFilter } from './app-inventory-contract.ts';
import { defineCommandFamily } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  booleanField,
  booleanSchema,
  enumField,
  integerField,
  jsonSchemaField,
  looseObjectField,
  looseObjectSchema,
  requiredField,
  stringArrayField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import {
  commonInputFromFlags,
  direct,
  optionalString,
  readJsonObject,
  request,
  requiredDaemonString,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter, CommandInput } from '../cli-grammar/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { DEFAULT_APPS_FILTER } from '../../contracts/app-inventory.ts';
import { managementCliOutputFormatters } from './output.ts';

const PREPARE_ACTION_VALUES = ['ios-runner'] as const;

const managementCommandDescriptions = {
  devices: 'List available devices.',
  boot: 'Boot or prepare a selected device without using CLI positional arguments.',
  shutdown: 'Shutdown a selected simulator or emulator.',
  apps: 'List installed apps.',
  session: 'List active sessions or print daemon state directory.',
  open: 'Open an app, deep link, URL, or platform surface.',
  prepare: 'Prepare platform helper infrastructure.',
  close: 'Close an app or end the active session.',
  install: 'Install an app binary.',
  reinstall: 'Reinstall an app binary.',
  'install-from-source': 'Install an app from a structured source.',
  push: 'Deliver a push payload.',
  'trigger-app-event': 'Trigger an app-defined event.',
} as const;

const managementCommandMetadata = [
  defineFieldCommandMetadata('devices', managementCommandDescriptions.devices, {}),
  defineFieldCommandMetadata('boot', managementCommandDescriptions.boot, {
    headless: booleanField('Boot without showing simulator UI when supported.'),
  }),
  defineFieldCommandMetadata('shutdown', managementCommandDescriptions.shutdown, {}),
  defineFieldCommandMetadata('prepare', managementCommandDescriptions.prepare, {
    action: requiredField(enumField(PREPARE_ACTION_VALUES)),
    timeoutMs: integerField('Maximum wall-clock time for the prepare command.'),
  }),
  defineFieldCommandMetadata('apps', managementCommandDescriptions.apps, {
    appsFilter: enumField(['user-installed', 'all']),
  }),
  defineFieldCommandMetadata('session', managementCommandDescriptions.session, {
    action: enumField(
      ['list', 'state-dir'],
      'list shows active sessions; state-dir prints the resolved daemon state directory without contacting the daemon.',
    ),
  }),
  defineFieldCommandMetadata('open', managementCommandDescriptions.open, {
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
  }),
  defineFieldCommandMetadata('close', managementCommandDescriptions.close, {
    app: stringField('Optional app to close.'),
    shutdown: booleanField('Shutdown the session/device where supported.'),
    saveScript: jsonSchemaField<boolean | string>({ oneOf: [booleanSchema(), stringSchema()] }),
  }),
  defineFieldCommandMetadata('install', managementCommandDescriptions.install, {
    app: requiredField(stringField()),
    appPath: requiredField(stringField('Path to app binary.')),
  }),
  defineFieldCommandMetadata('reinstall', managementCommandDescriptions.reinstall, {
    app: requiredField(stringField()),
    appPath: requiredField(stringField('Path to app binary.')),
  }),
  defineFieldCommandMetadata(
    'install-from-source',
    managementCommandDescriptions['install-from-source'],
    {
      source: requiredField(
        jsonSchemaField<DaemonInstallSource>(looseObjectSchema('Install source object.')),
      ),
      retainPaths: booleanField(),
      retentionMs: integerField(),
    },
  ),
  defineFieldCommandMetadata('push', managementCommandDescriptions.push, {
    app: requiredField(stringField()),
    payload: requiredField(
      jsonSchemaField<string | Record<string, unknown>>({
        oneOf: [stringSchema(), looseObjectSchema()],
      }),
    ),
  }),
  defineFieldCommandMetadata(
    'trigger-app-event',
    managementCommandDescriptions['trigger-app-event'],
    {
      event: requiredField(stringField()),
      payload: looseObjectField(),
    },
  ),
] as const;

type ManagementCommandMetadata = (typeof managementCommandMetadata)[number];
type ManagementCommandName = ManagementCommandMetadata['name'];

const managementCommandDefinitions = [
  defineExecutableCommand(metadata('devices'), (client, input) => client.devices.list(input)),
  defineExecutableCommand(metadata('boot'), (client, input) => client.devices.boot(input)),
  defineExecutableCommand(metadata('shutdown'), (client, input) => client.devices.shutdown(input)),
  defineExecutableCommand(metadata('apps'), (client, input) => client.apps.list(input)),
  defineExecutableCommand(metadata('session'), async (client, { action, ...input }) =>
    action === 'state-dir'
      ? { stateDir: await client.sessions.stateDir(input) }
      : { sessions: await client.sessions.list(input) },
  ),
  defineExecutableCommand(metadata('open'), (client, input) => client.apps.open(input)),
  defineExecutableCommand(metadata('close'), (client, input) =>
    input.app ? client.apps.close(input) : client.sessions.close(withoutApp(input)),
  ),
  defineExecutableCommand(metadata('install'), (client, input) => client.apps.install(input)),
  defineExecutableCommand(metadata('reinstall'), (client, input) => client.apps.reinstall(input)),
  defineExecutableCommand(metadata('install-from-source'), (client, input) =>
    client.apps.installFromSource(input),
  ),
  defineExecutableCommand(metadata('push'), (client, input) => client.apps.push(input)),
  defineExecutableCommand(metadata('trigger-app-event'), (client, input) =>
    client.apps.triggerEvent(input),
  ),
  defineExecutableCommand(metadata('prepare'), (client, input) => client.command.prepare(input)),
] as const;

const managementCliSchemas = {
  boot: {
    summary: 'Boot target device/simulator',
    allowedFlags: ['headless'],
  },
  shutdown: {
    summary: 'Shutdown target simulator/emulator',
  },
  prepare: {
    usageOverride: 'prepare ios-runner --platform ios|macos [--timeout <ms>]',
    listUsageOverride: 'prepare',
    helpDescription:
      'Prepare platform helper infrastructure. ios-runner builds/reuses, starts, and health-checks the XCTest runner so later Apple snapshots and interactions do not pay first-use startup cost. In CI, run it after boot/install and before replay/test; if replay/test starts a separate daemon, run clean:daemon after prepare to release the prepared runner lease. Runner build/start output is written to the session runner.log; daemon.log is for daemon lifecycle/startup issues.',
    summary:
      'Pre-warm platform helpers, especially the iOS/macOS XCTest runner before Apple automation',
    positionalArgs: ['ios-runner'],
    allowedFlags: ['timeoutMs'],
  },
  open: {
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
  },
  close: {
    positionalArgs: ['app?'],
    allowedFlags: ['saveScript', 'shutdown'],
  },
  reinstall: {
    positionalArgs: ['app', 'path'],
  },
  install: {
    positionalArgs: ['app', 'path'],
  },
  'install-from-source': {
    usageOverride:
      'install-from-source <url> | install-from-source --github-actions-artifact <owner/repo:artifact>',
    listUsageOverride: 'install-from-source',
    helpDescription:
      'Install app builds from URLs, remote source specs, or CI artifacts resolved by a remote daemon.',
    summary: 'Install app builds from URLs, remote source specs, or CI artifacts',
    positionalArgs: ['url?'],
    allowedFlags: [
      'header',
      'githubActionsArtifact',
      'installSource',
      'retainPaths',
      'retentionMs',
    ],
  },
  apps: {
    helpDescription: 'List user-installed apps; use --all to include system/OEM apps',
    summary: 'List installed apps',
    allowedFlags: ['appsFilter'],
    defaults: { appsFilter: DEFAULT_APPS_FILTER },
  },
  push: {
    listUsageOverride: 'push',
    helpDescription: 'Deliver push notification payloads to an installed app.',
    summary: 'Deliver push notification payloads to an installed app',
    positionalArgs: ['bundleOrPackage', 'payloadOrJson'],
  },
  'trigger-app-event': {
    usageOverride: 'trigger-app-event <event> [payloadJson]',
    listUsageOverride: 'trigger-app-event',
    helpDescription:
      'Invoke app-defined automation or test events with an optional structured payload.',
    summary: 'Invoke app-defined automation/test events with optional structured payloads',
    positionalArgs: ['event', 'payloadJson?'],
  },
  session: {
    usageOverride: 'session list | session state-dir',
    listUsageOverride: 'session',
    helpDescription: 'List active sessions or print the effective daemon state directory',
    positionalArgs: ['list|state-dir?'],
  },
} as const satisfies Record<string, CommandSchemaOverride>;

function metadata<TName extends ManagementCommandName>(
  name: TName,
): Extract<ManagementCommandMetadata, { name: TName }> {
  const definition = managementCommandMetadata.find((item) => item.name === name);
  if (!definition) throw new Error(`Missing management command metadata for ${name}`);
  return definition as Extract<ManagementCommandMetadata, { name: TName }>;
}

function withoutApp(input: AppCloseOptions & { shutdown?: boolean }): { shutdown?: boolean } {
  const { app: _app, ...rest } = input;
  return rest;
}

const appCliReaders = {
  devices: (_positionals, flags) => commonInputFromFlags(flags),
  apps: (_positionals, flags) => ({
    ...commonInputFromFlags(flags),
    appsFilter: assertResolvedAppsFilter(flags.appsFilter),
  }),
  session: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    action: readSessionAction(positionals[0]),
  }),
  boot: (_positionals, flags) => ({
    ...commonInputFromFlags(flags),
    headless: flags.headless,
  }),
  shutdown: (_positionals, flags) => commonInputFromFlags(flags),
  prepare: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    action: requiredString(positionals[0], 'prepare requires subcommand'),
    timeoutMs: flags.timeoutMs,
  }),
  open: (positionals, flags) => ({
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
  }),
  close: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    app: positionals[0],
    shutdown: flags.shutdown,
    saveScript: flags.saveScript,
  }),
  install: installInputFromCli,
  reinstall: installInputFromCli,
  'install-from-source': (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    source: resolveInstallSource(positionals, flags),
    retainPaths: flags.retainPaths,
    retentionMs: flags.retentionMs,
  }),
  push: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    app: requiredString(positionals[0], 'push requires bundleOrPackage'),
    payload: requiredString(positionals[1], 'push requires payloadOrJson'),
  }),
  'trigger-app-event': (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    event: requiredString(positionals[0], 'trigger-app-event requires event'),
    payload: positionals[1]
      ? readJsonObject(positionals[1], 'trigger-app-event payload')
      : undefined,
  }),
} satisfies Record<string, CliReader>;

const appDaemonWriters = {
  devices: direct(PUBLIC_COMMANDS.devices),
  boot: direct(PUBLIC_COMMANDS.boot),
  shutdown: direct(PUBLIC_COMMANDS.shutdown),
  prepare: direct(PUBLIC_COMMANDS.prepare, (input) => [
    requiredDaemonString(input.action, 'prepare requires subcommand'),
  ]),
  apps: direct(PUBLIC_COMMANDS.apps),
  open: direct(PUBLIC_COMMANDS.open, openPositionals),
  close: direct(PUBLIC_COMMANDS.close, (input) => optionalString(input.app)),
  install: direct(PUBLIC_COMMANDS.install, (input) => requiredPair(input.app, input.appPath)),
  reinstall: direct(PUBLIC_COMMANDS.reinstall, (input) => requiredPair(input.app, input.appPath)),
  'install-from-source': (input) =>
    request(INTERNAL_COMMANDS.installSource, [], {
      ...input,
      installSource: input.source,
      retainMaterializedPaths: input.retainPaths,
      materializedPathRetentionMs: input.retentionMs,
    }),
  push: direct(PUBLIC_COMMANDS.push, (input) => pushPositionals(input as AppPushOptions)),
  'trigger-app-event': direct(PUBLIC_COMMANDS.triggerAppEvent, (input) =>
    triggerEventPositionals(input as AppTriggerEventOptions),
  ),
} satisfies Record<string, DaemonWriter>;

export const managementCommandFamily = defineCommandFamily({
  name: 'management',
  metadata: managementCommandMetadata,
  definitions: managementCommandDefinitions,
  cliSchemas: managementCliSchemas,
  cliReaders: appCliReaders,
  daemonWriters: appDaemonWriters,
  cliOutputFormatters: managementCliOutputFormatters,
});

function installInputFromCli(
  positionals: string[],
  flags: CliFlags,
  command = 'install',
): Record<string, unknown> {
  return {
    ...commonInputFromFlags(flags),
    app: requiredString(positionals[0], `${command} requires app`),
    appPath: requiredString(positionals[1], `${command} requires path`),
  };
}

function readSessionAction(value: string | undefined): 'list' | 'state-dir' {
  const action = value ?? 'list';
  if (action === 'list') return action;
  if (action === 'state-dir') return action;
  throw new AppError('INVALID_ARGS', 'session only supports list or state-dir');
}

function openPositionals(input: CommandInput): string[] {
  if (!input.app) return [];
  return input.url ? [input.app, input.url] : [input.app];
}

function requiredPair(first: unknown, second: unknown): string[] {
  return [
    requiredDaemonString(first, 'missing first positional'),
    requiredDaemonString(second, 'missing second positional'),
  ];
}

function pushPositionals(input: AppPushOptions): string[] {
  return [
    input.app,
    typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload),
  ];
}

function triggerEventPositionals(input: AppTriggerEventOptions): string[] {
  return [input.event, ...(input.payload ? [JSON.stringify(input.payload)] : [])];
}

// fallow-ignore-next-line complexity
function resolveInstallSource(positionals: string[], flags: CliFlags) {
  const url = positionals[0]?.trim();
  if (positionals.length > 1) {
    throw new AppError(
      'INVALID_ARGS',
      'install-from-source accepts either one <url> positional or --github-actions-artifact',
    );
  }
  const githubArtifactSource = flags.githubActionsArtifact
    ? parseGitHubActionsArtifactInstallSourceSpec(flags.githubActionsArtifact)
    : undefined;
  const configuredSource = flags.installSource;
  const sourceCount = (url ? 1 : 0) + (githubArtifactSource ? 1 : 0) + (configuredSource ? 1 : 0);
  if (sourceCount !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      'install-from-source requires exactly one source: <url>, --github-actions-artifact, or config installSource',
    );
  }
  if (!url && flags.header && flags.header.length > 0) {
    throw new AppError(
      'INVALID_ARGS',
      'install-from-source --header is only supported for URL sources',
    );
  }
  if (githubArtifactSource) return githubArtifactSource;
  if (configuredSource) return configuredSource;
  return {
    kind: 'url' as const,
    url: url!,
    headers: parseInstallSourceHeaders(flags.header),
  };
}

function parseInstallSourceHeaders(
  headerFlags: CliFlags['header'],
): Record<string, string> | undefined {
  if (!headerFlags || headerFlags.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const rawHeader of headerFlags) {
    const separator = rawHeader.indexOf(':');
    if (separator <= 0) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid --header value "${rawHeader}". Expected "name:value".`,
      );
    }
    const name = rawHeader.slice(0, separator).trim();
    const value = rawHeader.slice(separator + 1).trim();
    if (!name) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid --header value "${rawHeader}". Header name cannot be empty.`,
      );
    }
    headers[name] = value;
  }
  return headers;
}
