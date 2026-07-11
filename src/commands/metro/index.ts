import type {
  MetroPrepareOptions,
  MetroPrepareResult,
  MetroReloadOptions,
  MetroReloadResult,
} from '../../client/client-types.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import {
  booleanField,
  enumField,
  integerField,
  jsonSchemaField,
  requiredField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { METRO_PREPARE_FLAGS, METRO_RELOAD_FLAGS } from '../cli-grammar/flag-groups.ts';
import { metroCliOutputFormatters } from './output.ts';
import { readMetroPrepareKind } from './prepare-kind.ts';

const METRO_COMMAND_NAME = 'metro';
const METRO_ACTION_VALUES = ['prepare', 'reload'] as const;

const metroCommandDescription = 'Prepare React Native dev-server runtime or reload apps.';

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
    'metro prepare (--public-base-url <url> | --proxy-base-url <url>) [--project-root <path>] [--port <port>] [--kind auto|react-native|expo|repack]\n  agent-device metro reload [--metro-host <host>] [--metro-port <port>] [--bundle-url <url>]',
  listUsageOverride: 'metro',
  helpDescription:
    'Prepare a local React Native dev-server runtime or ask connected apps to reload. ' +
    'reload with no --metro-host/--metro-port/--bundle-url resolves against the dev server ' +
    "this session last bound via metro prepare or open's metro hint flags (falling back to " +
    'localhost:8081 only when the session never bound one), so it never silently reloads a ' +
    "different project's server on the default port; pass an explicit flag to override the " +
    'session hint for one call. The reload URL keeps the bound bundle URL mount prefix instead ' +
    'of collapsing to the host root, and when the server has no HTTP /reload route (Expo) the ' +
    'reload is broadcast over its /message websocket instead of trusting the app-page fallback. ' +
    'The binding is cleared when the session closes, and a fresh ' +
    'open without hint flags also clears any leftover binding from a previous same-name session. ' +
    '--kind expo (detected or forced) requests the virtual-entry bundle URL ' +
    '(.expo/.virtual-metro-entry.bundle) instead of index.bundle, since index.bundle 404s/500s ' +
    'against Expo dev servers in monorepos. Dependency install auto-detects the package manager ' +
    'from the nearest yarn.lock/pnpm-lock.yaml/bun.lock/bun.lockb/package-lock.json walking up ' +
    'from --project-root (bounded at the repo root), so Yarn/pnpm workspace monorepos with the ' +
    'lockfile at the repo root do not wrongly fall back to npm install (which fails on ' +
    'workspace: dependency specifiers); if install still fails, pass --no-install-deps when ' +
    'dependencies are already installed (for example via a monorepo root install).',
  summary: 'Prepare Metro/Re.Pack reachability for React Native/Expo apps or trigger app reloads',
  positionalArgs: ['prepare|reload'],
  allowedFlags: [...METRO_RELOAD_FLAGS, ...METRO_PREPARE_FLAGS],
} as const satisfies CommandSchemaOverride;

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

const metroCommandFacet = defineCommandFacet({
  name: METRO_COMMAND_NAME,
  metadata: metroCommandMetadata,
  definition: metroCommandDefinition,
  cliSchema: metroCliSchema,
  cliReader: metroCliReader,
  cliOutputFormatter: metroCliOutputFormatters.metro,
});

export const metroCommandFamily = defineCommandFamilyFromFacets({
  name: 'metro',
  commands: [metroCommandFacet],
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
