import type { CommandFlags } from '@agent-device/contracts/command';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { getFlagDefinitionsForKey } from './flag-registry.ts';
import type { FlagKey } from './flag-types.ts';
import { resolveCommandStandaloneProjection } from './registry.ts';

export type StandaloneCommandOmission = 'secret-bearing' | 'not-cli-representable';
export type StandaloneCommandResult =
  | Readonly<{ standaloneCommand: string; standaloneCommandOmitted?: never }>
  | Readonly<{ standaloneCommand?: never; standaloneCommandOmitted: StandaloneCommandOmission }>;

export type StandalonePublicForm = Readonly<{
  positionals: readonly string[];
  options: Readonly<Partial<Record<FlagKey, string | number | boolean>>>;
}>;

type ProjectableRequest = Readonly<{
  command: string;
  positionals?: readonly string[];
  flags?: CommandFlags;
  session: string;
}>;

// These rows describe the effective public options that each active refusal producer can emit.
// The CLI parity test checks each key against the strict public parser's command schema.
export const STANDALONE_COMMAND_OPTIONS = {
  perf: ['kind', 'perfTemplate', 'out'],
  record: ['recordingScope', 'fps', 'quality', 'hideTouches'],
  logs: ['restart'],
  audio: [],
  trace: [],
  test: [
    'replayMaestro',
    'replayUpdate',
    'metroHost',
    'metroPort',
    'bundleUrl',
    'failFast',
    'timeoutMs',
    'retries',
    'recordVideo',
    'artifactsDir',
    'reporter',
    'reportJunit',
    'shardAll',
    'shardSplit',
    'testIme',
  ],
} as const satisfies Partial<Record<string, readonly FlagKey[]>>;

const TARGET_KEYS = ['platform', 'target', 'device', 'udid', 'serial'] as const;
const PRIVATE_CONTEXT_KEYS = new Set<string>([
  'config',
  'remoteConfig',
  'stateDir',
  'daemonBaseUrl',
  'daemonAuthToken',
  'daemonTransport',
  'daemonServerMode',
  'tenant',
  'sessionIsolation',
  'runId',
  'leaseId',
  'leaseBackend',
  'leaseProvider',
  'provider',
  'providerSessionId',
  'deviceKey',
  'clientId',
  'sessionLock',
  'androidDeviceAllowlist',
  'iosSimulatorDeviceSet',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'json',
  'verbose',
  'cost',
  'responseLevel',
  'batchSteps',
  'batchOnError',
  'batchMaxSteps',
  'steps',
  'stepsFile',
  'replayScriptSources',
  'replayScriptSource',
  'replayShellEnv',
]);

function disclosureRisk(value: string): StandaloneCommandOmission | undefined {
  if (/[\r\n\0]/.test(value)) return 'secret-bearing';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return 'secret-bearing';
    } catch {
      return 'not-cli-representable';
    }
  }
  return undefined;
}

function publicFlag(key: FlagKey, value: string | number | boolean): string[] | undefined {
  const definition = getFlagDefinitionsForKey(key).find(
    (entry) =>
      entry.names.some((name) => name.startsWith('--')) &&
      (entry.setValue === undefined || entry.setValue === value),
  );
  const name = definition?.names.find((entry) => entry.startsWith('--'));
  if (!name) return undefined;
  if (typeof value === 'boolean') return value ? [name] : [];
  return [name, String(value)];
}

export function projectStandaloneCommand(
  req: ProjectableRequest,
  publicForm?: StandalonePublicForm | null,
): StandaloneCommandResult {
  if (publicForm === null) return { standaloneCommandOmitted: 'not-cli-representable' };
  const projection = resolveCommandStandaloneProjection(req.command);
  if (!projection) return { standaloneCommandOmitted: 'not-cli-representable' };
  const flags = req.flags ?? {};
  if (flags.session !== undefined && flags.session !== req.session)
    return { standaloneCommandOmitted: 'not-cli-representable' };
  if (req.command === 'test' && flags.replayEnv?.length)
    return { standaloneCommandOmitted: 'secret-bearing' };
  const row = STANDALONE_COMMAND_OPTIONS[req.command as keyof typeof STANDALONE_COMMAND_OPTIONS];
  const options: Record<string, string | number | boolean> = { ...(publicForm?.options ?? {}) };
  if (req.command === 'test') {
    if (flags.replayBackend !== undefined && flags.replayBackend !== 'maestro')
      return { standaloneCommandOmitted: 'not-cli-representable' };
    if (flags.replayBackend === 'maestro') options.replayMaestro = true;
  }
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || key === 'session' || TARGET_KEYS.includes(key as never)) continue;
    if (req.command === 'audio' && (key === 'durationMs' || key === 'bucketMs')) continue;
    if (
      PRIVATE_CONTEXT_KEYS.has(key) ||
      ((key === 'out' || key === 'testIme') && !row?.includes(key as never))
    )
      continue;
    if (key === 'replayBackend' && req.command === 'test') continue;
    if (row?.includes(key as never) && publicForm?.options[key as FlagKey] === undefined) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
        return { standaloneCommandOmitted: 'not-cli-representable' };
      options[key] = value;
    } else if (!row?.includes(key as never)) {
      return { standaloneCommandOmitted: 'not-cli-representable' };
    }
  }
  if (Object.keys(options).some((key) => !row?.includes(key as never)))
    return { standaloneCommandOmitted: 'not-cli-representable' };
  const words = [
    'agent-device',
    projection.command,
    ...(publicForm?.positionals ?? req.positionals ?? []),
  ];
  const values = [req.session, ...words.slice(2)];
  for (const key of TARGET_KEYS) {
    const value = flags[key];
    if (value !== undefined) values.push(String(value));
  }
  for (const value of Object.values(options)) values.push(String(value));
  const omission = values.map(disclosureRisk).find(Boolean);
  if (omission) return { standaloneCommandOmitted: omission };
  for (const key of TARGET_KEYS) {
    const value = flags[key];
    if (value !== undefined) {
      const flag = publicFlag(key, String(value));
      if (!flag) return { standaloneCommandOmitted: 'not-cli-representable' };
      words.push(...flag);
    }
  }
  for (const [key, value] of Object.entries(options)) {
    const flag = publicFlag(key as FlagKey, value);
    if (!flag) return { standaloneCommandOmitted: 'not-cli-representable' };
    words.push(...flag);
  }
  words.push('--session', req.session);
  return { standaloneCommand: words.map(shellQuoteIfNeeded).join(' ') };
}
