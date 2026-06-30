import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { DaemonInstallSource } from '../../kernel/contracts.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { AppError } from '../../kernel/errors.ts';
import { parseGitHubActionsArtifactInstallSourceSpec } from '../../utils/install-source-config.ts';
import {
  booleanField,
  jsonSchemaField,
  looseObjectSchema,
  requiredField,
  integerField,
  stringField,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  request,
  requiredDaemonString,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const installCommandMetadata = defineFieldCommandMetadata('install', 'Install an app binary.', {
  app: stringField('Optional app identifier hint.'),
  appPath: requiredField(stringField('Path to app binary.')),
});

const reinstallCommandMetadata = defineFieldCommandMetadata(
  'reinstall',
  'Reinstall an app binary.',
  {
    app: requiredField(stringField()),
    appPath: requiredField(stringField('Path to app binary.')),
  },
);

const installFromSourceCommandMetadata = defineFieldCommandMetadata(
  'install-from-source',
  'Install an app from a structured source.',
  {
    source: requiredField(
      jsonSchemaField<DaemonInstallSource>(looseObjectSchema('Install source object.')),
    ),
    retainPaths: booleanField(),
    retentionMs: integerField(),
  },
);

const installCommandDefinition = defineExecutableCommand(installCommandMetadata, (client, input) =>
  client.apps.install(input),
);

const reinstallCommandDefinition = defineExecutableCommand(
  reinstallCommandMetadata,
  (client, input) => client.apps.reinstall(input),
);

const installFromSourceCommandDefinition = defineExecutableCommand(
  installFromSourceCommandMetadata,
  (client, input) => client.apps.installFromSource(input),
);

const installCliSchema = {
  usageOverride: 'install <path> | install <app> <path>',
  listUsageOverride: 'install <path>',
  positionalArgs: ['appOrPath', 'path?'],
} as const satisfies CommandSchemaOverride;

const reinstallCliSchema = {
  positionalArgs: ['app', 'path'],
} as const satisfies CommandSchemaOverride;

const installFromSourceCliSchema = {
  usageOverride:
    'install-from-source <url> | install-from-source --github-actions-artifact <owner/repo:artifact>',
  listUsageOverride: 'install-from-source',
  helpDescription:
    'Install app builds from URLs, remote source specs, or CI artifacts resolved by a remote daemon.',
  summary: 'Install app builds from URLs, remote source specs, or CI artifacts',
  positionalArgs: ['url?'],
  allowedFlags: ['header', 'githubActionsArtifact', 'installSource', 'retainPaths', 'retentionMs'],
} as const satisfies CommandSchemaOverride;

const installCliReader: CliReader = (positionals, flags) => installInputFromCli(positionals, flags);

const reinstallCliReader: CliReader = (positionals, flags) =>
  reinstallInputFromCli(positionals, flags);

const installFromSourceCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  source: resolveInstallSource(positionals, flags),
  retainPaths: flags.retainPaths,
  retentionMs: flags.retentionMs,
});

const installDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.install, (input) =>
  installPositionals(input.app, input.appPath),
);

const reinstallDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.reinstall, (input) =>
  requiredPair(input.app, input.appPath),
);

const installFromSourceDaemonWriter: DaemonWriter = (input) =>
  request(INTERNAL_COMMANDS.installSource, [], {
    ...input,
    installSource: input.source,
    retainMaterializedPaths: input.retainPaths,
    materializedPathRetentionMs: input.retentionMs,
  });

const installCommandFacet = defineCommandFacet({
  name: 'install',
  metadata: installCommandMetadata,
  definition: installCommandDefinition,
  cliSchema: installCliSchema,
  cliReader: installCliReader,
  daemonWriter: installDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.install,
});

const reinstallCommandFacet = defineCommandFacet({
  name: 'reinstall',
  metadata: reinstallCommandMetadata,
  definition: reinstallCommandDefinition,
  cliSchema: reinstallCliSchema,
  cliReader: reinstallCliReader,
  daemonWriter: reinstallDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.reinstall,
});

const installFromSourceCommandFacet = defineCommandFacet({
  name: 'install-from-source',
  metadata: installFromSourceCommandMetadata,
  definition: installFromSourceCommandDefinition,
  cliSchema: installFromSourceCliSchema,
  cliReader: installFromSourceCliReader,
  daemonWriter: installFromSourceDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters['install-from-source'],
});

export const installManagementCommandFacets = [
  installCommandFacet,
  reinstallCommandFacet,
  installFromSourceCommandFacet,
] as const;

function installInputFromCli(positionals: string[], flags: CliFlags): Record<string, unknown> {
  const [first, second] = positionals;
  const hasExplicitApp = second !== undefined;
  return {
    ...commonInputFromFlags(flags),
    ...(hasExplicitApp ? { app: requiredString(first, 'install requires app') } : {}),
    appPath: requiredString(hasExplicitApp ? second : first, 'install requires path'),
  };
}

function reinstallInputFromCli(positionals: string[], flags: CliFlags): Record<string, unknown> {
  return {
    ...commonInputFromFlags(flags),
    app: requiredString(positionals[0], 'reinstall requires app'),
    appPath: requiredString(positionals[1], 'reinstall requires path'),
  };
}

function installPositionals(app: unknown, appPath: unknown): string[] {
  const path = requiredDaemonString(appPath, 'missing app path');
  return typeof app === 'string' && app.length > 0 ? [app, path] : [path];
}

function requiredPair(first: unknown, second: unknown): string[] {
  return [
    requiredDaemonString(first, 'missing first positional'),
    requiredDaemonString(second, 'missing second positional'),
  ];
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
