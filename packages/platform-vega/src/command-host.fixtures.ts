import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './__tests__/tmp-dir.ts';
import type { PlatformHost } from 'agent-device/plugins';
import type { VegaCommandOptions, VegaCommandResult, VegaCommandRunner } from './command-host.ts';
import { createVegaToolbox, type VegaToolbox } from './toolbox.ts';

/** One command the plugin asked its host to run, plus what the host was told about it. */
export type VegaHostStubCommand = Readonly<{
  executable: string;
  args: readonly string[];
  timeoutMs: number | undefined;
  allowFailure: boolean | undefined;
  signal: AbortSignal | undefined;
}>;

export type VegaHostStub = Readonly<{
  toolbox: VegaToolbox;
  host: PlatformHost;
  /** Every command the plugin asked the host to run, in order. */
  commands: VegaHostStubCommand[];
  /** How many times the plugin asked the host to resolve an executable on its PATH. */
  pathProbes(): number;
  /** Queues one answer for the next command; exit code 0 is the common case. */
  answer(answer?: Partial<VegaCommandResult> & Readonly<{ stdout?: string }>): void;
}>;

const NO_ANSWER: VegaCommandResult = Object.freeze({
  stdout: '',
  stderr: 'vega-host-stub: no answer queued',
  exitCode: 1,
});

/**
 * Binds the plugin's toolbox to an in-memory host for colocated unit tests: nothing spawns, and
 * every command the plugin asks for is recorded with the executable and argv the plugin built. Tests
 * assert on those, which is what this family's CLI contract is.
 */
export function createVegaHostStub(
  input: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    /** The executables the host's `PATH` resolves; `['vega']` is the common case. */
    onPath?: readonly string[];
    /** Absolute paths the host finds executable, for the home's default-install probe. */
    executableFiles?: readonly string[];
    /** The stdout every command answers with, for a test about an answer rather than about argv. */
    stdout?: string;
    /** Answers one command. Takes precedence over `stdout` and the queued answers. */
    respond?: (
      executable: string,
      args: readonly string[],
    ) => Partial<VegaCommandResult> & Readonly<{ stdout?: string }>;
    /** Rejected one command, the way the host rejects a spawn it cannot start. */
    reject?: (executable: string, args: readonly string[]) => Error;
  }> = {},
): VegaHostStub {
  const onPath = new Set(input.onPath ?? ['vega']);
  const executableFiles = new Set(input.executableFiles ?? []);
  const commands: VegaHostStubCommand[] = [];
  const answers: VegaCommandResult[] = [];
  let pathProbes = 0;
  const host = Object.freeze({
    env: input.env ?? { PATH: '/usr/bin', HOME: '/host-home' },
    cwd: '/host-cwd',
    stateDir: '/host-state',
    emitDiagnostic: () => {},
    withDiagnosticTimer: async (_phase: string, operation: () => Promise<unknown>) =>
      await operation(),
    isFileExecutable: async (candidate: string) => executableFiles.has(candidate),
    isExecutableOnPath: async (executable: string) => {
      pathProbes += 1;
      return onPath.has(executable);
    },
    listHostProcesses: async () => [],
    runCommand: async (
      executable: string,
      args: string[],
      options: { timeoutMs?: number; allowFailure?: boolean; signal?: AbortSignal },
    ): Promise<VegaCommandResult> => {
      commands.push({
        executable,
        args,
        timeoutMs: options.timeoutMs,
        allowFailure: options.allowFailure,
        signal: options.signal,
      });
      if (input.reject) throw input.reject(executable, args);
      if (input.respond) return toResult(input.respond(executable, args));
      if (input.stdout !== undefined) return toResult({ stdout: input.stdout });
      return answers.shift() ?? NO_ANSWER;
    },
  }) as unknown as PlatformHost;
  return Object.freeze({
    toolbox: createVegaToolbox(host),
    host,
    commands,
    pathProbes: () => pathProbes,
    answer: (answer) => {
      answers.push(toResult(answer));
    },
  });
}

/** One CLI call a module made through the family's command route. */
export type VegaCommandRunnerStubCall = Readonly<{
  args: readonly string[];
  timeoutMs: number | undefined;
  allowFailure: boolean | undefined;
}>;

export type VegaCommandRunnerStub = VegaCommandRunner &
  Readonly<{ calls: VegaCommandRunnerStubCall[] }>;

/**
 * The plugin's command route with recorded argv, for a test about one module's CLI calls rather than
 * about the host seam. It answers queued results and nothing spawns.
 */
export function createVegaCommandRunnerStub(
  answers: readonly (Partial<VegaCommandResult> & Readonly<{ stdout?: string }>)[] = [],
): VegaCommandRunnerStub {
  const queued = answers.map(toResult);
  const calls: VegaCommandRunnerStubCall[] = [];
  return {
    calls,
    resolveExecutable: async () => 'vega',
    run: async (args: readonly string[], options?: VegaCommandOptions) => {
      calls.push({ args, timeoutMs: options?.timeoutMs, allowFailure: options?.allowFailure });
      return queued.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

/**
 * A Vega CLI the plugin can find: a scratch directory holding an executable `vega`, so a test that
 * names a home proves the resolver answers from a file on disk rather than from a stubbed verdict.
 */
export function createVegaDefaultInstall(homeDirectory: string): string {
  const install = path.join(homeDirectory, 'vega', 'bin', 'vega');
  fs.mkdirSync(path.dirname(install), { recursive: true });
  fs.writeFileSync(install, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return install;
}

/** A scratch host home, for a resolver test that must not read the process home. */
export function createVegaHostHome(): string {
  return mkdtempForTestSync('vega-host-home-');
}

function toResult(
  answer?: Partial<VegaCommandResult> & Readonly<{ stdout?: string }>,
): VegaCommandResult {
  return {
    stdout: answer?.stdout ?? '',
    stderr: answer?.stderr ?? '',
    exitCode: answer?.exitCode ?? 0,
  };
}
