import type { CommandName } from '../commands/command-metadata.ts';
import { listCommandFamilyCliSchemas } from '../commands/family/registry.ts';
import type { LocalCliCommandName } from '../command-catalog.ts';
import type { CommandSchema, CommandSchemaOverride } from './types.ts';
import {
  COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  METRO_PREPARE_FLAGS,
} from '../commands/cli-grammar/flag-groups.ts';

type SchemaOnlyCliCommandName = Exclude<LocalCliCommandName, CommandName>;

const SCHEMA_ONLY_CLI_COMMAND_SCHEMAS = {
  cdp: {
    usageOverride: 'cdp [...args]',
    listUsageOverride: 'cdp',
    helpDescription:
      'Run CDP commands for React Native diagnostics, JS heap usage, heap snapshots, and leak analysis',
    summary:
      'Inspect React Native CDP targets, JS heap growth, heap snapshots, retainers, and leak signals',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
    supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  },
  auth: {
    usageOverride: 'auth status|login|logout',
    listUsageOverride: 'auth',
    helpDescription: 'Manage cloud login state used by remote daemon and cloud device workflows.',
    summary: 'Manage cloud login state used by remote daemon and cloud device workflows',
    positionalArgs: ['status|login|logout'],
    supportedFlags: ['remoteConfig', 'stateDir'],
  },
  connect: {
    usageOverride:
      'connect [cloud|proxy|browserstack|aws-device-farm] [--remote-config <path>] [--daemon-base-url <url>] [--tenant <id>] [--run-id <id>] [--lease-id <id>] [--lease-backend <backend>] [--force] [--no-login]',
    helpDescription:
      'Connect to a remote daemon, authenticate when needed, and save remote session state. AGENT_DEVICE_CLOUD_BASE_URL is the bridge/control-plane API origin; use AGENT_DEVICE_DAEMON_AUTH_TOKEN=adc_live_... for CI/service-token automation.',
    listUsageOverride: 'connect',
    summary:
      'Attach CLI commands to a saved remote daemon/cloud lease; inspect for remote runs, tenants, or service-token CI',
    allowedFlags: [
      'remoteConfig',
      'daemonBaseUrl',
      'tenant',
      'runId',
      'leaseId',
      'leaseBackend',
      'providerApp',
      'providerOsVersion',
      'providerProject',
      'providerBuild',
      'providerSessionName',
      'awsProjectArn',
      'awsDeviceArn',
      'awsAppArn',
      'awsRegion',
      'awsInteractionMode',
      'force',
      'noLogin',
    ],
    supportedFlags: [
      'stateDir',
      'daemonAuthToken',
      'session',
      'platform',
      'device',
      ...METRO_PREPARE_FLAGS,
      'launchUrl',
    ],
  },
  connection: {
    usageOverride: 'connection status',
    listUsageOverride: 'connection',
    helpDescription: 'Inspect active remote connection state',
    summary: 'Inspect the active saved remote connection before assuming commands are local',
    positionalArgs: ['status'],
    supportedFlags: ['remoteConfig', 'stateDir', 'session'],
  },
  disconnect: {
    helpDescription:
      'Disconnect remote daemon state, stop owned Metro companion, and release lease',
    listUsageOverride: 'disconnect',
    summary:
      'Clear remote connection state, stop owned Metro companions, and release remote leases',
    allowedFlags: ['shutdown'],
    supportedFlags: ['remoteConfig', 'stateDir', 'session'],
  },
  mcp: {
    helpDescription:
      'Start the official stdio MCP server. It exposes structured command tools backed by the agent-device client.',
    summary: 'Start MCP server',
  },
  proxy: {
    usageOverride:
      'proxy [--host <host>] [--port <port>] [--daemon-auth-token <token>] [--state-dir <path>]',
    listUsageOverride: 'proxy',
    helpDescription: `Expose the local daemon HTTP contract through a tunnel-friendly reverse proxy.

Run this on the host that has access to simulators/devices, expose the printed local proxy URL through a tunnel, then point another machine at the tunnel URL with connect proxy.

The proxy starts or reuses a local HTTP daemon, accepts /health, /rpc, /upload and resumable /upload/* routes, and /artifacts plus /artifacts/*, and also accepts the same routes under /agent-device/*. Health is unauthenticated for reachability probes. Other routes require the generated bearer token printed at startup, or the explicit --daemon-auth-token value when provided. The proxy rewrites authorized client requests to the upstream daemon token instead of exposing the local daemon token.

Use the /agent-device base path when connecting through cloudflared, ngrok, or another shared origin. Treat the bearer token as a secret; anyone with it can control the proxied daemon. This direct proxy flow does not use agent-device auth.

Examples:
  agent-device proxy --port 4310
  cloudflared tunnel --url http://127.0.0.1:4310
  agent-device connect proxy --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>`,
    summary: 'Expose a local daemon through cloudflared, ngrok, or another HTTP tunnel',
    allowedFlags: ['proxyHost', 'proxyPort', 'daemonAuthToken', 'stateDir'],
  },
  'react-devtools': {
    usageOverride: 'react-devtools [...args]',
    listUsageOverride: 'react-devtools',
    helpDescription:
      'Run pinned agent-react-devtools commands for React Native performance profiling, component trees, props/state/hooks, and render analysis',
    summary:
      'Inspect React Native components, props, hooks, errors, slow renders, and rerender profiles',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
    supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  },
  web: {
    usageOverride: 'web setup | web doctor',
    listUsageOverride: 'web setup|doctor',
    helpDescription: `Install and inspect the managed web automation backend used by --platform web.

First-run flow:
  agent-device web setup
  agent-device open "https://example.com" --platform web
  agent-device snapshot -i --platform web
  agent-device close --platform web

Runtime web commands do not install the backend implicitly. If the managed backend is missing, run agent-device web setup. The backend is resolved only from the managed install in the effective agent-device state dir.

Use web setup to install or reuse the pinned backend. Use web doctor after setup to verify browser backend health.`,
    summary: 'Manage web automation backend',
    positionalArgs: ['setup|doctor'],
    supportedFlags: ['stateDir'],
  },
} as const satisfies Record<SchemaOnlyCliCommandName, CommandSchema>;

const CLI_COMMAND_OVERRIDES = listCommandFamilyCliSchemas() as Partial<
  Record<CommandName, CommandSchemaOverride>
>;

export function getSchemaOnlyCliCommandSchema(command: string): CommandSchema | undefined {
  return Object.hasOwn(SCHEMA_ONLY_CLI_COMMAND_SCHEMAS, command)
    ? SCHEMA_ONLY_CLI_COMMAND_SCHEMAS[command as keyof typeof SCHEMA_ONLY_CLI_COMMAND_SCHEMAS]
    : undefined;
}

export function getCliCommandOverride(command: string): CommandSchemaOverride | undefined {
  return Object.hasOwn(CLI_COMMAND_OVERRIDES, command)
    ? CLI_COMMAND_OVERRIDES[command as keyof typeof CLI_COMMAND_OVERRIDES]
    : undefined;
}
