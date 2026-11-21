import type { PlatformHost } from 'agent-device/plugins';
import { runCmd, type ExecOptions } from '@agent-device/host-kit/command';
import type { DiagnosticEventInput } from '@agent-device/host-kit/diagnostics';
import { hostTemporaryDirectory } from '@agent-device/host-kit/host-file';
import {
  expandProcessTree,
  hostNodeExecutablePath,
  hostNodeVersion,
  hostPlatform,
  hostProcessId,
  isProcessAlive,
  processStartTimesDiffer,
  readHostProcessIdentityObservationsAsync,
  readProcessExecutablePaths,
  readProcessIdentities,
  type HostProcessIdentityFacts,
  type HostProcessInfo,
  type OwnedProcessRecordStore,
  type OwnedProcessReapSummary,
} from '@agent-device/host-kit/process';
import type {
  OwnedProcessRecord,
  RecordedProcessLiveness,
} from '@agent-device/contracts/platform-runtime-host';
import { createWebToolbox, type WebToolbox } from './toolbox.ts';

/** One command the plugin asked its host to run, plus what the host was told about it. */
export type WebHostStubCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>> | undefined;
  timeoutMs: number | undefined;
  allowFailure: boolean | undefined;
  signal: AbortSignal | undefined;
  stdin: string | undefined;
}>;

/** One process read the plugin asked its host to make, with the pids it named. */
export type WebHostStubProcessRead = Readonly<
  | { kind: 'table'; pids: [] }
  | { kind: 'identities'; pids: readonly number[] }
  | { kind: 'executable-paths'; pids: readonly number[] }
  | { kind: 'liveness'; pids: readonly number[] }
  | {
      kind: 'reap';
      pids: [];
      store: OwnedProcessRecordStore;
      options: Parameters<PlatformHost['processes']['reapOwnedRecords']>[1];
    }
  | {
      kind: 'lock';
      pids: [];
      lockDirPath: string;
      timeoutMs: number;
      description: string | undefined;
    }
>;

/** Every process read the plugin asked its host to make, in order. */
export type WebHostStubProcessReads = WebHostStubProcessRead[];

/**
 * What a host stub answers a process read with; absent fields read as the host not answering. Each
 * answer is awaited, so a fixture can hand back a real host-kit read instead of a table.
 */
export type WebHostStubProcesses = Readonly<{
  identities?: (
    pids: readonly number[],
  ) =>
    | Promise<ReadonlyMap<number, HostProcessIdentityFacts>>
    | ReadonlyMap<number, HostProcessIdentityFacts>;
  executablePaths?: (
    pids: readonly number[],
  ) => Promise<ReadonlyMap<number, string>> | ReadonlyMap<number, string>;
  /**
   * The host's judgement of the records the plugin asked about. Absent, the stub answers the way a
   * host that could read nothing does: every record stays unknown evidence.
   */
  liveness?: (
    records: readonly OwnedProcessRecord[],
  ) => Promise<readonly RecordedProcessLiveness[]> | readonly RecordedProcessLiveness[];
  reap?: OwnedProcessReapSummary;
}>;

export type WebHostStub = Readonly<{
  toolbox: WebToolbox;
  host: PlatformHost;
  /** Every command the plugin asked the host to run, in order. */
  commands: WebHostStubCommand[];
  /** Every diagnostic the plugin emitted through its host, in order. */
  diagnostics: DiagnosticEventInput[];
  /** Every process read the plugin asked the host to make, in order. */
  processReads: WebHostStubProcessReads;
  /** Answers the next process-table reads in order; the last one is reused once they run out. */
  answerProcessTable(reads: readonly HostProcessInfo[][]): void;
}>;

/**
 * Binds the plugin's toolbox to an in-memory host for colocated unit tests. Nothing spawns of its
 * own: each command is recorded with the argv and environment the plugin built, and then handed to
 * `runCmd`, so a test that answers through `withCommandExecutorOverride` keeps working while still
 * proving the command travelled through the plugin's host rather than around it. Every process read is
 * recorded and answered the same way, so a test proves the fleet scan and the orphan reap asked the
 * host instead of running a process tool through the host-kit copy the plugin ships with.
 */
export function createWebHostStub(
  input: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    cwd?: string;
    stateDir?: string;
    /** Answers one process-table read; the plugin reads the table to derive its fleet record. */
    processes?: HostProcessInfo[];
    /** Answers the identity, liveness, executable-path and reap calls; defaults to nothing. */
    readProcesses?: (reads: WebHostStubProcessReads) => WebHostStubProcesses;
    ownedProcessRecords?: PlatformHost['ownedProcessRecords'];
    openWebSessionNames?: () => readonly string[];
  }> = {},
): WebHostStub {
  const commands: WebHostStubCommand[] = [];
  const diagnostics: DiagnosticEventInput[] = [];
  const processTable: HostProcessInfo[][] = [];
  const processReads: WebHostStubProcessReads = [];
  const answered = input.readProcesses?.(processReads) ?? {};
  let nextProcessTableRead = 0;
  // Typed as the real port, so a change to the facet is a type error here rather than a missing cast.
  const processes: PlatformHost['processes'] = {
    list: async () => {
      processReads.push({ kind: 'table', pids: [] });
      const answer =
        processTable[nextProcessTableRead] ?? input.processes ?? processTable.at(-1) ?? [];
      nextProcessTableRead += 1;
      return answer;
    },
    readIdentities: async (pids) => {
      const named = [...pids];
      processReads.push({ kind: 'identities', pids: named });
      return answered.identities?.(named) ?? new Map();
    },
    readExecutablePaths: async (pids) => {
      const named = [...pids];
      processReads.push({ kind: 'executable-paths', pids: named });
      return answered.executablePaths?.(named) ?? new Map();
    },
    // The stub expands with the host kit's own rule, so the scan is answered the way the host answers
    // it, while the plugin still has to ask rather than run the expansion of its own bundled copy.
    expandTree: (rootPids, processes) =>
      expandProcessTree([...rootPids], [...processes]).map((processInfo) => ({ ...processInfo })),
    judgeRecordedLiveness: async (records) => {
      const named = [...records];
      processReads.push({ kind: 'liveness', pids: named.map((record) => record.pid) });
      return (await answered.liveness?.(named)) ?? named.map(() => 'unobserved' as const);
    },
    reapOwnedRecords: async (store, options) => {
      processReads.push({ kind: 'reap', pids: [], store, options });
      return answered.reap ?? EMPTY_REAP_SUMMARY;
    },
    // The stub runs the task inline: one test process cannot contend with itself for a lock, and what a
    // test needs to see is that the plugin asked its host to hold it.
    withLock: async (params) => {
      processReads.push({
        kind: 'lock',
        pids: [],
        lockDirPath: params.lockDirPath,
        timeoutMs: params.timeoutMs,
        description: params.description,
      });
      return await params.task();
    },
  };
  const host = Object.freeze({
    env: input.env ?? process.env,
    cwd: input.cwd ?? process.cwd(),
    stateDir: input.stateDir ?? '/host-state',
    // The machine the stub's commands would really run on: the same one the test process runs on, so
    // the plugin's install layout, launch argv and self-pid exclusion are the production ones.
    ...realHostMachineFacts(),
    runCommand: async (
      executable: string,
      args: string[],
      options: ExecOptions & { stdin?: string },
    ) => {
      commands.push({
        executable,
        args,
        env: options.env,
        timeoutMs: options.timeoutMs,
        allowFailure: options.allowFailure,
        signal: options.signal,
        stdin: typeof options.stdin === 'string' ? options.stdin : undefined,
      });
      return await runCmd(executable, args, options);
    },
    isFileExecutable: async () => false,
    isExecutableOnPath: async () => false,
    processes,
    emitDiagnostic: (event: DiagnosticEventInput) => {
      diagnostics.push(event);
    },
    withDiagnosticTimer: async <T>(_phase: string, operation: () => Promise<T>): Promise<T> =>
      await operation(),
    ...(input.ownedProcessRecords === undefined
      ? {}
      : { ownedProcessRecords: input.ownedProcessRecords }),
    ...(input.openWebSessionNames === undefined
      ? {}
      : { openWebSessionNames: input.openWebSessionNames }),
  }) as unknown as PlatformHost;
  return Object.freeze({
    toolbox: createWebToolbox(host),
    host,
    commands,
    diagnostics,
    processReads,
    answerProcessTable: (reads: readonly HostProcessInfo[][]) => {
      processTable.push(...reads.map((read) => [...read]));
      nextProcessTableRead = 0;
    },
  });
}

/**
 * Answers the process reads with the real host-kit reads, for a test that wants the host to answer for
 * the machine it actually runs on rather than from a fixture. `@agent-device/host-kit/process` is
 * runtime-importable here: a `*.fixtures.*` file never ships in a plugin bundle.
 */
export function realHostProcessReads(): WebHostStubProcesses {
  return {
    identities: async (pids) => await readProcessIdentities(pids),
    executablePaths: async (pids) =>
      await readProcessExecutablePaths(pids, { env: process.env, cwd: process.cwd() }),
    liveness: async (records) => await judgeRecordedLivenessLikeTheHost(records),
  };
}

/**
 * The machine answers a host stub gives, read from the process the test runs in.
 *
 * A plugin builds its managed install layout, the argv it launches, and the pid a fleet scan must not
 * match as its own from these, and asks its host for them rather than reading process globals of its
 * own (R13). A stub therefore has to answer them, and reading them here keeps a fixture from
 * re-implementing what the core's own plugin host answers. A `*.fixtures.*` file may not be imported
 * by another test, so this one small answer lives beside the toolbox the host stub stands in for.
 */
export function realHostMachineFacts(): Pick<
  PlatformHost,
  'hostOs' | 'nodeExecutablePath' | 'nodeVersion' | 'temporaryDirectory' | 'processId'
> {
  const platform = hostPlatform();
  return {
    hostOs:
      platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other',
    nodeExecutablePath: hostNodeExecutablePath(),
    nodeVersion: hostNodeVersion(),
    temporaryDirectory: hostTemporaryDirectory(),
    processId: hostProcessId(),
  };
}

/**
 * The host's own fail-closed record judgement, answered with this process's reads. A test that wants
 * the gate to decide for the machine it runs on asks for this rather than re-implementing the rule.
 */
export async function judgeRecordedLivenessLikeTheHost(
  records: readonly OwnedProcessRecord[],
): Promise<readonly RecordedProcessLiveness[]> {
  if (records.length === 0) return [];
  const observations = await readHostProcessIdentityObservationsAsync(
    records.map((record) => record.pid),
  );
  return records.map((record) => {
    const observation = observations.get(record.pid);
    if (observation === undefined) return isProcessAlive(record.pid) ? 'unobserved' : 'not-alive';
    if (
      observation.state.startsWith('Z') ||
      processStartTimesDiffer(observation.startTime, record.startTime)
    )
      return 'not-alive';
    return observation.startTime === record.startTime ? 'alive' : 'unobserved';
  });
}

/** A reap that inspected nothing: a stub test asserts the reap was asked, not what it stopped. */
const EMPTY_REAP_SUMMARY: OwnedProcessReapSummary = {
  inspected: 0,
  inspectedPids: [],
  terminated: 0,
  terminatedPids: [],
  missing: 0,
  missingPids: [],
  unconfirmed: 0,
  unconfirmedPids: [],
  survived: 0,
  survivedPids: [],
  skippedForOpenWebSession: false,
};
