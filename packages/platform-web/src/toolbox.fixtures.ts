import type { PlatformHost } from 'agent-device/plugins';
import { runCmd, type ExecOptions } from '@agent-device/host-kit/command';
import type { DiagnosticEventInput } from '@agent-device/host-kit/diagnostics';
import type { HostProcessInfo } from '@agent-device/host-kit/process';
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

export type WebHostStub = Readonly<{
  toolbox: WebToolbox;
  host: PlatformHost;
  /** Every command the plugin asked the host to run, in order. */
  commands: WebHostStubCommand[];
  /** Every diagnostic the plugin emitted through its host, in order. */
  diagnostics: DiagnosticEventInput[];
  /** Answers the next process-table reads in order; the last one is reused once they run out. */
  answerProcessTable(reads: readonly HostProcessInfo[][]): void;
}>;

/**
 * Binds the plugin's toolbox to an in-memory host for colocated unit tests. Nothing spawns of its
 * own: each command is recorded with the argv and environment the plugin built, and then handed to
 * `runCmd`, so a test that answers through `withCommandExecutorOverride` keeps working while still
 * proving the command travelled through the plugin's host rather than around it.
 */
export function createWebHostStub(
  input: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    cwd?: string;
    stateDir?: string;
    /** Answers one process-table read; the plugin reads the table to derive its fleet record. */
    processes?: HostProcessInfo[];
    ownedProcessRecords?: PlatformHost['ownedProcessRecords'];
    openWebSessionNames?: () => readonly string[];
  }> = {},
): WebHostStub {
  const commands: WebHostStubCommand[] = [];
  const diagnostics: DiagnosticEventInput[] = [];
  const processTable: HostProcessInfo[][] = [];
  let processReads = 0;
  const host = Object.freeze({
    env: input.env ?? process.env,
    cwd: input.cwd ?? process.cwd(),
    stateDir: input.stateDir ?? '/host-state',
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
    listHostProcesses: async () => {
      const answer = processTable[processReads] ?? input.processes ?? processTable.at(-1) ?? [];
      processReads += 1;
      return answer;
    },
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
    answerProcessTable: (reads: readonly HostProcessInfo[][]) => {
      processTable.push(...reads.map((read) => [...read]));
      processReads = 0;
    },
  });
}
