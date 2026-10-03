import type {
  AgentDeviceRuntime,
  AgentDeviceRuntimeConfig,
  CommandPolicy,
  CommandSessionRecord,
  CommandSessionStore,
} from './runtime-contract.ts';

/**
 * Assembles an in-process runtime from its backend, artifact adapter, session store, policy and
 * cancellation inputs. Carries no command surface: whoever needs bound commands composes them on
 * the result, so a consumer that only reads `backend`/`sessions`/`policy` does not evaluate the
 * command families it never dispatches.
 */
export function createAgentDeviceRuntime(config: AgentDeviceRuntimeConfig): AgentDeviceRuntime {
  return {
    backend: config.backend,
    artifacts: config.artifacts,
    sessions: config.sessions ?? createMemorySessionStore(),
    policy: config.policy ?? restrictedCommandPolicy(),
    diagnostics: config.diagnostics,
    clock: config.clock,
    signal: config.signal,
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
    ...overrides,
  };
}

export function restrictedCommandPolicy(overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return {
    allowLocalInputPaths: false,
    allowLocalOutputPaths: false,
    maxImagePixels: 20_000_000,
    ...overrides,
  };
}
