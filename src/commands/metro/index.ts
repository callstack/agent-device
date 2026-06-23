import type { MetroPrepareKind } from '../../client-metro.ts';
import type {
  MetroPrepareOptions,
  MetroPrepareResult,
  MetroReloadOptions,
  MetroReloadResult,
} from '../../client-types.ts';
import { AppError } from '../../utils/errors.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import {
  booleanField,
  enumField,
  integerField,
  jsonSchemaField,
  requiredField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { defineCommandFamily } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { METRO_PREPARE_FLAGS, METRO_RELOAD_FLAGS } from '../../utils/cli-flags.ts';
import { metroCliOutputFormatters } from './output.ts';

const METRO_COMMAND_NAME = 'metro';
const METRO_ACTION_VALUES = ['prepare', 'reload'] as const;

const metroCommandDescription = 'Prepare Metro runtime or reload React Native apps.';

export const metroCommandMetadata = defineFieldCommandMetadata(
  METRO_COMMAND_NAME,
  metroCommandDescription,
  {
    action: requiredField(enumField(METRO_ACTION_VALUES)),
    projectRoot: stringField(),
    kind: jsonSchemaField<MetroPrepareOptions['kind']>(stringSchema()),
    publicBaseUrl: stringField(),
    proxyBaseUrl: stringField(),
    bearerToken: stringField(),
    bridgeScope: jsonSchemaField<MetroPrepareOptions['bridgeScope']>({
      type: 'object',
      additionalProperties: true,
    }),
    launchUrl: stringField(),
    port: integerField(),
    listenHost: stringField(),
    statusHost: stringField(),
    startupTimeoutMs: integerField(),
    probeTimeoutMs: integerField(),
    reuseExisting: booleanField(),
    installDependenciesIfNeeded: booleanField(),
    runtimeFilePath: stringField(),
    logPath: stringField(),
    metroHost: stringField(),
    metroPort: integerField(),
    bundleUrl: stringField(),
    timeoutMs: integerField(),
  },
);

type MetroInput = { action: 'prepare' | 'reload' } & MetroPrepareOptions & MetroReloadOptions;

export const metroCommandDefinition = defineExecutableCommand(
  metroCommandMetadata,
  async (client, input): Promise<MetroPrepareResult | MetroReloadResult> =>
    input.action === 'prepare'
      ? await client.metro.prepare(toMetroPrepareOptions(input))
      : await client.metro.reload(toMetroReloadOptions(input)),
);

const metroCliSchema = {
  usageOverride:
    'metro prepare (--public-base-url <url> | --proxy-base-url <url>) [--project-root <path>] [--port <port>] [--kind auto|react-native|expo]\n  agent-device metro reload [--metro-host <host>] [--metro-port <port>] [--bundle-url <url>]',
  listUsageOverride: 'metro',
  helpDescription:
    'Prepare a local Metro runtime or ask Metro to reload connected React Native apps',
  summary: 'Prepare Metro reachability for React Native/Expo apps or trigger app reloads',
  positionalArgs: ['prepare|reload'],
  allowedFlags: [...METRO_RELOAD_FLAGS, ...METRO_PREPARE_FLAGS],
} as const satisfies CommandSchemaOverride;

const metroCliSchemas = {
  [METRO_COMMAND_NAME]: metroCliSchema,
} as const satisfies Record<string, CommandSchemaOverride>;

export const metroCliReader: CliReader = (positionals, flags) => {
  const action = (positionals[0] ?? '').toLowerCase();
  if (action !== 'prepare' && action !== 'reload') {
    throw new AppError('INVALID_ARGS', 'metro requires a subcommand: prepare or reload');
  }
  if (action === 'reload') {
    return {
      action,
      metroHost: flags.metroHost,
      metroPort: flags.metroPort,
      bundleUrl: flags.bundleUrl,
      timeoutMs: flags.metroProbeTimeoutMs,
    };
  }
  if (!flags.metroPublicBaseUrl && !flags.metroProxyBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'metro prepare requires --public-base-url <url> or --proxy-base-url <url>.',
    );
  }
  return {
    action,
    projectRoot: flags.metroProjectRoot,
    kind: readMetroPrepareKind(flags.kind ?? flags.metroKind),
    port: flags.metroPreparePort,
    listenHost: flags.metroListenHost,
    statusHost: flags.metroStatusHost,
    publicBaseUrl: flags.metroPublicBaseUrl,
    proxyBaseUrl: flags.metroProxyBaseUrl,
    bearerToken: flags.metroBearerToken,
    bridgeScope:
      flags.tenant && flags.runId && flags.leaseId
        ? {
            tenantId: flags.tenant,
            runId: flags.runId,
            leaseId: flags.leaseId,
          }
        : undefined,
    startupTimeoutMs: flags.metroStartupTimeoutMs,
    probeTimeoutMs: flags.metroProbeTimeoutMs,
    reuseExisting: flags.metroNoReuseExisting ? false : undefined,
    installDependenciesIfNeeded: flags.metroNoInstallDeps ? false : undefined,
    runtimeFilePath: flags.metroRuntimeFile,
  };
};

const metroCliReaders = {
  metro: metroCliReader,
} satisfies Record<string, CliReader>;

export const metroCommandFamily = defineCommandFamily({
  name: 'metro',
  metadata: [metroCommandMetadata],
  definitions: [metroCommandDefinition],
  cliSchemas: metroCliSchemas,
  cliReaders: metroCliReaders,
  cliOutputFormatters: metroCliOutputFormatters,
});

function toMetroPrepareOptions(input: MetroInput): MetroPrepareOptions {
  return {
    projectRoot: input.projectRoot,
    kind: input.kind,
    publicBaseUrl: input.publicBaseUrl,
    proxyBaseUrl: input.proxyBaseUrl,
    bearerToken: input.bearerToken,
    bridgeScope: input.bridgeScope ?? metroBridgeScopeFromInput(input),
    port: input.port,
    listenHost: input.listenHost,
    statusHost: input.statusHost,
    startupTimeoutMs: input.startupTimeoutMs,
    probeTimeoutMs: input.probeTimeoutMs,
    reuseExisting: input.reuseExisting,
    installDependenciesIfNeeded: input.installDependenciesIfNeeded,
    runtimeFilePath: input.runtimeFilePath,
  };
}

function metroBridgeScopeFromInput(
  input: MetroInput & {
    tenant?: string;
    runId?: string;
    leaseId?: string;
  },
): MetroPrepareOptions['bridgeScope'] {
  return input.tenant && input.runId && input.leaseId
    ? { tenantId: input.tenant, runId: input.runId, leaseId: input.leaseId }
    : undefined;
}

function toMetroReloadOptions(input: MetroInput): MetroReloadOptions {
  return {
    metroHost: input.metroHost,
    metroPort: input.metroPort,
    bundleUrl: input.bundleUrl,
    timeoutMs: input.timeoutMs,
  };
}

function readMetroPrepareKind(value: string | undefined): MetroPrepareKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'react-native' || value === 'expo') return value;
  throw new AppError('INVALID_ARGS', 'metro prepare --kind must be auto, react-native, or expo');
}
