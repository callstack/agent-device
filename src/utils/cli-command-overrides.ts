import type { CommandName } from '../commands/command-metadata.ts';
import { batchCliSchemas } from '../commands/batch/index.ts';
import { captureCliSchemas } from '../commands/capture/index.ts';
import { debuggingCliSchemas } from '../commands/debugging/index.ts';
import { interactionCliSchemas } from '../commands/interaction/index.ts';
import { managementCliSchemas } from '../commands/management/index.ts';
import { metroCliSchemas } from '../commands/metro/index.ts';
import { observabilityCliSchemas } from '../commands/observability/index.ts';
import { perfCliSchemas } from '../commands/perf/index.ts';
import { reactNativeCliSchemas } from '../commands/react-native/index.ts';
import { recordingCliSchemas } from '../commands/recording/index.ts';
import { replayCliSchemas } from '../commands/replay/index.ts';
import { systemCliSchemas } from '../commands/system/index.ts';
import type { LocalCliCommandName } from '../command-catalog.ts';
import type { CommandSchema, CommandSchemaOverride } from './cli-command-schema-types.ts';
import { METRO_PREPARE_FLAGS } from './cli-flags.ts';

type SchemaOnlyCliCommandName = Exclude<LocalCliCommandName, CommandName>;

const SCHEMA_ONLY_CLI_COMMAND_SCHEMAS = {
  auth: {
    usageOverride: 'auth status|login|logout',
    listUsageOverride: 'auth status|login|logout',
    helpDescription: 'Manage cloud CLI authentication',
    summary: 'Manage cloud authentication',
    positionalArgs: ['status|login|logout'],
  },
  connect: {
    usageOverride:
      'connect [--remote-config <path>] [--tenant <id>] [--run-id <id>] [--lease-backend <backend>] [--force] [--no-login]',
    helpDescription:
      'Connect to a remote daemon, authenticate when needed, and save remote session state. AGENT_DEVICE_CLOUD_BASE_URL is the bridge/control-plane API origin; use AGENT_DEVICE_DAEMON_AUTH_TOKEN=adc_live_... for CI/service-token automation.',
    summary: 'Connect to remote daemon',
    allowedFlags: ['force', 'noLogin', ...METRO_PREPARE_FLAGS, 'launchUrl'],
  },
  connection: {
    usageOverride: 'connection status',
    listUsageOverride: 'connection status',
    helpDescription: 'Inspect active remote connection state',
    summary: 'Inspect remote connection',
    positionalArgs: ['status'],
  },
  disconnect: {
    helpDescription:
      'Disconnect remote daemon state, stop owned Metro companion, and release lease',
    summary: 'Disconnect remote daemon',
    allowedFlags: ['shutdown'],
  },
  mcp: {
    helpDescription:
      'Start the official stdio MCP server. It exposes structured command tools backed by the agent-device client.',
    summary: 'Start MCP server',
  },
  'react-devtools': {
    usageOverride: 'react-devtools [...args]',
    listUsageOverride: 'react-devtools [...args]',
    helpDescription:
      'Run pinned agent-react-devtools commands for React Native performance profiling, component trees, props/state/hooks, and render analysis',
    summary: 'Profile React Native performance and component renders',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
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
  },
} as const satisfies Record<SchemaOnlyCliCommandName, CommandSchema>;

const CLI_COMMAND_OVERRIDES = {
  ...managementCliSchemas,
  ...captureCliSchemas,
  ...systemCliSchemas,
  ...interactionCliSchemas,
  ...observabilityCliSchemas,
  ...perfCliSchemas,
  ...debuggingCliSchemas,
  ...metroCliSchemas,
  ...replayCliSchemas,
  ...batchCliSchemas,
  ...recordingCliSchemas,
  ...reactNativeCliSchemas,
} as const satisfies Partial<Record<CommandName, CommandSchemaOverride>>;

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
