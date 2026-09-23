import {
  HOST_PLATFORM_EXECUTION,
  NO_PLATFORM_EXECUTION,
  ownerFilesEnabled,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import { inventoryUse } from '@agent-device/contracts/platform-module';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The local client-backed commands (`catalog.group: 'local-cli'`): they answer on the caller's
 * machine or against the local daemon, so they declare no daemon route and no device policy.
 */
export const LOCAL_CLI_COMMAND_DESCRIPTORS = [
  // -- local client-backed CLI/MCP commands (no daemon route/capability) --
  {
    name: 'debug',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/debugging/index.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: this route reads local diagnostics files and has no daemon route, no
    // platform import, and no injected dispatch — it was `legacy` only because the discriminator
    // pass had nothing better to say about it.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'daemon',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/daemon.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    // `stop --clean` reconciles owner-scoped Apple runner resources through the neutral
    // daemon-owner cleanup service. It is host execution, not a request-bound device operation.
    platformExecution: HOST_PLATFORM_EXECUTION,
  },
  {
    name: 'device',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/device.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'metro',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/metro/index.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'session',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/session.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'cdp',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/agent-cdp.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'auth',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/auth.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'connect',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/connection.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'connection',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/connection.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'disconnect',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/connection.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'mcp',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/bin.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'proxy',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/proxy.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'takeover',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/takeover.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: { kind: 'inventory', use: inventoryUse },
  },
  {
    name: 'react-devtools',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/react-devtools.ts'] as const } : {}),
    catalog: { group: 'local-cli', key: 'reactDevtools' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    // Wave 6 residue: `react-devtools start` on a Limrun Android instance dispatches internal
    // `runtime port-reverse` through the CLI-injected dispatch seam. `runtime` is itself fully
    // migrated (`device-runtime`, R31), so the dispatched execution is accounted for under its
    // own descriptor rather than hidden behind this one — this route owns no unmigrated platform
    // execution of its own. The CLI-route dominance gate
    // (`__tests__/platform-execution-cli-route.test.ts`) still rejects a `none` route whose
    // CLI-injected dispatch target is still `legacy`.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'web',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/web.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    // setup/doctor mutate and inspect the managed browser installed on this host through the
    // neutral managed-web-backend service. Live web sessions remain device-runtime owned.
    platformExecution: HOST_PLATFORM_EXECUTION,
  },
] as const satisfies readonly RawCommandDescriptor[];
