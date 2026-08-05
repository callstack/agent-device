import type { CommandName } from '../commands/command-metadata.ts';
import { listCommandFamilyCliSchemas } from '../commands/family/registry.ts';
import type { LocalCliCommandName } from '../command-catalog.ts';
import type { CommandSchema } from './types.ts';
import {
  COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  METRO_PREPARE_FLAGS,
} from '../commands/cli-grammar/flag-groups.ts';

type SchemaOnlyCliCommandName = Exclude<LocalCliCommandName, CommandName>;

const SCHEMA_ONLY_CLI_COMMAND_SCHEMAS = {
  cdp: {
    text: {
      summary: 'Inspect CDP targets, JS heap, and leaks',
      description:
        'Run CDP commands for React Native diagnostics, JS heap usage, heap snapshots, and leak analysis',
    },
    usageOverride: 'cdp [...args]',
    listUsageOverride: 'cdp',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
    supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  },
  auth: {
    text: {
      summary: 'Manage cloud login state',
      description: 'Manage cloud login state used by remote daemon and cloud device workflows.',
    },
    usageOverride: 'auth status|login|logout',
    listUsageOverride: 'auth',
    positionalArgs: ['status|login|logout'],
    supportedFlags: ['remoteConfig', 'stateDir'],
  },
  daemon: {
    text: {
      summary: 'Stop a local daemon and clean up resources',
      description:
        'Stop a local daemon after verifying its PID/start-time identity. Use --clean to remove retained Apple runner processes and leases owned by that daemon.',
    },
    usageOverride: 'daemon stop [--state-dir <path>] [--clean]',
    listUsageOverride: 'daemon stop',
    positionalArgs: ['stop'],
    allowedFlags: ['clean'],
    supportedFlags: ['stateDir'],
  },
  device: {
    text: {
      summary: 'Inspect local advisory device ownership without daemon side effects',
      description:
        'Inspect advisory host-local device ownership claims without starting or contacting a daemon. --stale only inspects proven-stale claims; it does not reclaim claims or clean platform resources.',
    },
    usageOverride:
      'device status [--platform <platform>] [--udid <udid>] [--serial <serial>] [--stale]',
    listUsageOverride: 'device status',
    positionalArgs: ['status'],
    allowedFlags: ['stale'],
    supportedFlags: ['platform', 'device', 'udid', 'serial'],
  },
  connect: {
    text: {
      summary: 'Configure remote or provider state',
      description:
        'Configure remote access without allocating a device. Direct providers validate credentials/resources before saving state and print the exact device/app preparation needed before open. AGENT_DEVICE_CLOUD_BASE_URL is the bridge/control-plane API origin; use AGENT_DEVICE_DAEMON_AUTH_TOKEN=adc_live_... for CI/service-token automation.',
    },
    usageOverride:
      'connect [cloud|proxy|limrun|browserstack|aws-device-farm] [--remote-config <path>] [--daemon-base-url <url>] [--tenant <id>] [--run-id <id>] [--lease-id <id>] [--lease-backend <backend>] [--force] [--no-login]',
    listUsageOverride: 'connect',
    positionalArgs: ['provider?'],
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
      'providerDeviceOrientation',
      'providerGeoLocation',
      'providerTimezone',
      'providerLanguage',
      'providerLocale',
      'providerNetworkProfile',
      'providerCustomNetwork',
      'providerNoResignApp',
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
    text: {
      summary: 'Inspect the saved remote connection',
      description: 'Inspect active remote connection state',
    },
    usageOverride: 'connection status',
    listUsageOverride: 'connection',
    positionalArgs: ['status'],
    supportedFlags: ['remoteConfig', 'stateDir', 'session'],
  },
  disconnect: {
    text: {
      summary: 'Clear remote connection state and release leases',
      description: 'Disconnect remote daemon state, stop owned Metro companion, and release lease',
    },
    listUsageOverride: 'disconnect',
    allowedFlags: ['shutdown'],
    supportedFlags: ['remoteConfig', 'stateDir', 'session'],
  },
  mcp: {
    text: {
      summary: 'Start MCP server',
      description:
        'Start the official stdio MCP server. It exposes structured command tools backed by the agent-device client.',
    },
  },
  proxy: {
    text: {
      summary: 'Expose a local daemon through an HTTP tunnel',
      description:
        'Expose the local daemon HTTP contract through a tunnel-friendly reverse proxy.\n\nRun this on the host that has access to simulators/devices, expose the printed local proxy URL through a tunnel, then point another machine at the tunnel URL with connect proxy.\n\nThe proxy starts or reuses a local HTTP daemon, accepts /health, /rpc, /upload and resumable /upload/* routes, and /artifacts plus /artifacts/*, and also accepts the same routes under /agent-device/*. Health is unauthenticated for reachability probes. Other routes require the generated bearer token printed at startup, or the explicit --daemon-auth-token value when provided. The proxy rewrites authorized client requests to the upstream daemon token instead of exposing the local daemon token.\n\nUse the /agent-device base path when connecting through cloudflared, ngrok, or another shared origin. Treat the bearer token as a secret; anyone with it can control the proxied daemon. This direct proxy flow does not use agent-device auth.\n\nExamples:\n  agent-device proxy --port 4310\n  cloudflared tunnel --url http://127.0.0.1:4310\n  agent-device connect proxy --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>',
    },
    usageOverride:
      'proxy [--host <host>] [--port <port>] [--daemon-auth-token <token>] [--state-dir <path>]',
    listUsageOverride: 'proxy',
    allowedFlags: ['proxyHost', 'proxyPort', 'daemonAuthToken', 'stateDir'],
  },
  'react-devtools': {
    text: {
      summary: 'Inspect components, hooks, and render profiles',
      description:
        'Run pinned agent-react-devtools commands for React Native performance profiling, component trees, props/state/hooks, and render analysis',
    },
    usageOverride: 'react-devtools [...args]',
    listUsageOverride: 'react-devtools',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
    supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  },
  web: {
    text: {
      summary: 'Manage web automation backend',
      description:
        'Install and inspect the managed web automation backend used by --platform web.\n\nFirst-run flow:\n  agent-device web setup\n  agent-device open "https://example.com" --platform web\n  agent-device snapshot -i --platform web\n  agent-device close --platform web\n\nRuntime web commands do not install the backend implicitly. If the managed backend is missing, run agent-device web setup. The backend is resolved only from the managed install in the effective agent-device state dir.\n\nUse web setup to install or reuse the pinned backend. Use web doctor after setup to verify browser backend health.',
    },
    usageOverride: 'web setup | web doctor',
    listUsageOverride: 'web setup|doctor',
    positionalArgs: ['setup|doctor'],
    supportedFlags: ['stateDir'],
  },
} as const satisfies Record<SchemaOnlyCliCommandName, CommandSchema>;

// Facet schemas are complete: `defineCommandFacet` attaches the resolved text to every one.
const CLI_COMMAND_OVERRIDES = listCommandFamilyCliSchemas() as Partial<
  Record<CommandName, CommandSchema>
>;

export function getSchemaOnlyCliCommandSchema(command: string): CommandSchema | undefined {
  return Object.hasOwn(SCHEMA_ONLY_CLI_COMMAND_SCHEMAS, command)
    ? SCHEMA_ONLY_CLI_COMMAND_SCHEMAS[command as keyof typeof SCHEMA_ONLY_CLI_COMMAND_SCHEMAS]
    : undefined;
}

export function getCliCommandOverride(command: string): CommandSchema | undefined {
  return Object.hasOwn(CLI_COMMAND_OVERRIDES, command)
    ? CLI_COMMAND_OVERRIDES[command as keyof typeof CLI_COMMAND_OVERRIDES]
    : undefined;
}
