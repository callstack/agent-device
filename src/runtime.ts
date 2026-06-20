import { bindCommands, type BoundAgentDeviceCommands } from './commands/index.ts';
import type {
  AgentDeviceRuntime,
  AgentDeviceRuntimeConfig,
  CommandPolicy,
  CommandSessionRecord,
  CommandSessionStore,
} from './runtime-contract.ts';

export type {
  AgentDeviceRuntime,
  AgentDeviceRuntimeConfig,
  CommandClock,
  CommandContext,
  CommandPolicy,
  CommandSessionRecord,
  CommandSessionStore,
  DiagnosticsSink,
} from './runtime-contract.ts';

export type AgentDevice = AgentDeviceRuntime & BoundAgentDeviceCommands;

export function createAgentDevice(config: AgentDeviceRuntimeConfig): AgentDevice {
  const runtime: AgentDeviceRuntime = {
    backend: config.backend,
    artifacts: config.artifacts,
    sessions: config.sessions ?? createMemorySessionStore(),
    policy: config.policy ?? restrictedCommandPolicy(),
    diagnostics: config.diagnostics,
    clock: config.clock,
    signal: config.signal,
  };

  return {
    ...runtime,
    ...bindCommands(runtime),
  };
}

export function createMemorySessionStore(
  records: readonly CommandSessionRecord[] = [],
): CommandSessionStore {
  const sessions = new Map(records.map((record) => [record.name, cloneSessionRecord(record)]));
  return {
    get: (name) => cloneSessionRecord(sessions.get(name)),
    set: (record) => {
      sessions.set(record.name, cloneSessionRecord(record));
    },
    delete: (name) => {
      sessions.delete(name);
    },
    list: () => Array.from(sessions.values(), (record) => cloneSessionRecord(record)),
  };
}

function cloneSessionRecord(record: CommandSessionRecord): CommandSessionRecord;
function cloneSessionRecord(record: undefined): undefined;
function cloneSessionRecord(
  record: CommandSessionRecord | undefined,
): CommandSessionRecord | undefined;
function cloneSessionRecord(
  record: CommandSessionRecord | undefined,
): CommandSessionRecord | undefined {
  if (!record) return undefined;
  return {
    ...record,
    ...(record.snapshot ? { snapshot: structuredClone(record.snapshot) } : {}),
    ...(record.metadata ? { metadata: cloneMetadata(record.metadata) } : {}),
  };
}

function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(metadata) as Record<string, unknown>;
  } catch {
    return { ...metadata };
  }
}

export function localCommandPolicy(overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return {
    allowLocalInputPaths: true,
    allowLocalOutputPaths: true,
    maxImagePixels: 20_000_000,
    allowNamedBackendCapabilities: [],
    ...overrides,
  };
}

export function restrictedCommandPolicy(overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return {
    allowLocalInputPaths: false,
    allowLocalOutputPaths: false,
    maxImagePixels: 20_000_000,
    allowNamedBackendCapabilities: [],
    ...overrides,
  };
}
