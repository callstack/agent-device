import { mkdtempForTestSync } from '@agent-device/test-kit';
import fs from 'node:fs';
import path from 'node:path';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { PlatformHost } from 'agent-device/plugins';
import type { HarmonyCommandResult } from './command-host.ts';
import { createHarmonyToolbox, type HarmonyToolbox } from './toolbox.ts';
import type { HarmonyHdcRunner } from './hdc.ts';

/** One command this stubbed host was asked to run, plus the environment it was handed. */
export type HarmonyHostStubCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env: HostEnvironment['env'] | undefined;
  timeoutMs: number | undefined;
  allowFailure: boolean | undefined;
  signal: AbortSignal | undefined;
}>;

export type HarmonyHostStub = Readonly<{
  toolbox: HarmonyToolbox;
  host: PlatformHost;
  /** Every command the plugin asked the host to run, in order. */
  commands: HarmonyHostStubCommand[];
  /** Queues one answer for the next command; exit code 0 is the common case. */
  answer(answer?: Partial<HarmonyCommandResult> & Readonly<{ stdout?: string }>): void;
}>;

const NO_ANSWER: HarmonyCommandResult = Object.freeze({
  stdout: '',
  stderr: 'harmony-host-stub: no answer queued',
  exitCode: 1,
});

/**
 * Binds the plugin's toolbox to an in-memory host for colocated unit tests: nothing spawns, and
 * every command the plugin asks for is recorded with the environment the plugin built. Tests assert
 * on the argv and on `PATH`, which is what the family's toolchain contract is.
 */
export function createHarmonyHostStub(
  input: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    /** Answers one command. Takes precedence over the queued answers. */
    respond?: (
      executable: string,
      args: readonly string[],
    ) => Partial<HarmonyCommandResult> & Readonly<{ stdout?: string }>;
    /** Rejected one command, the way the host rejects a spawn it cannot start. */
    reject?: (executable: string, args: readonly string[]) => Error;
  }> = {},
): HarmonyHostStub {
  const env = input.env ?? { PATH: '/usr/bin' };
  const commands: HarmonyHostStubCommand[] = [];
  const answers: HarmonyCommandResult[] = [];
  const host = Object.freeze({
    env,
    cwd: '/host-cwd',
    stateDir: '/host-state',
    emitDiagnostic: () => {},
    withDiagnosticTimer: async (_phase: string, operation: () => Promise<unknown>) =>
      await operation(),
    // The host's own executable probe, reading the real filesystem: the family's documented-root
    // probe stays a real answer here rather than a stubbed verdict, so a test that names a root
    // proves the plugin resolves HDC from it.
    isFileExecutable: async (candidate: string) => {
      try {
        const stat = await fs.promises.stat(candidate);
        await fs.promises.access(candidate, fs.constants.X_OK);
        return stat.isFile();
      } catch {
        return false;
      }
    },
    runCommand: async (
      executable: string,
      args: string[],
      options: {
        env?: Readonly<Record<string, string>>;
        timeoutMs?: number;
        allowFailure?: boolean;
        signal?: AbortSignal;
      },
    ): Promise<HarmonyCommandResult> => {
      commands.push({
        executable,
        args,
        env: options.env,
        timeoutMs: options.timeoutMs,
        allowFailure: options.allowFailure,
        signal: options.signal,
      });
      if (input.reject) throw input.reject(executable, args);
      if (input.respond) return toResult(input.respond(executable, args));
      return answers.shift() ?? NO_ANSWER;
    },
  }) as unknown as PlatformHost;
  return Object.freeze({
    toolbox: createHarmonyToolbox(host),
    host,
    commands,
    answer: (answer) => {
      answers.push(toResult(answer));
    },
  });
}

/**
 * The plugin's toolbox with one part replaced, for a test about one module's HDC calls rather than
 * about the host seam. `createHarmonyHdcRunnerStub` records what the module asked the device.
 */
export function createHarmonyToolboxWith(
  toolbox: HarmonyToolbox,
  overrides: Readonly<{ hdc?: HarmonyHdcRunner }>,
): HarmonyToolbox {
  return Object.freeze({ ...toolbox, ...overrides });
}

/**
 * A toolchain root the plugin can find: a scratch directory holding an executable `hdc`, so the
 * family's documented-root probe answers for real instead of through a stubbed filesystem.
 */
export function createHarmonyToolchainRoot(contents = '#!/bin/sh\necho stub\n'): string {
  const root = mkdtempForTestSync('harmony-toolchain-');
  fs.writeFileSync(path.join(root, 'hdc'), contents, { mode: 0o755 });
  return root;
}

/** The `PATH` entries the plugin handed one command. */
export function harmonyCommandPath(command: HarmonyHostStubCommand): readonly string[] {
  return (command.env?.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/** One HDC call a module made through the family's HDC route. */
export type HarmonyHdcStubCall = Readonly<{
  kind: 'launch' | 'run' | 'runShell';
  target: string | undefined;
  /** The command words as the module passed them; shell words for `runShell`. */
  args: readonly unknown[];
  options: Readonly<Record<string, unknown>>;
}>;

export type HarmonyHdcRunnerStub = {
  -readonly [K in keyof HarmonyHdcRunner]: HarmonyHdcRunner[K];
} & Readonly<{
  calls: HarmonyHdcStubCall[];
  /** Queues the answer for the next call of any kind; exit code 0 is the common case. */
  answer(answer?: Partial<HarmonyCommandResult> & Readonly<{ stdout?: string }>): void;
}>;

/**
 * Records the HDC calls a module makes, for tests about one module's commands rather than about the
 * host seam. It answers queued results and nothing spawns.
 */
export function createHarmonyHdcRunnerStub(
  answers: readonly (Partial<HarmonyCommandResult> & Readonly<{ stdout?: string }>)[] = [],
): HarmonyHdcRunnerStub {
  const calls: HarmonyHdcStubCall[] = [];
  const queued = answers.map(toResult);
  const record = (
    kind: HarmonyHdcStubCall['kind'],
    device: Readonly<{ id: string }> | undefined,
    args: readonly unknown[],
    options: Readonly<Record<string, unknown>>,
  ): HarmonyCommandResult => {
    calls.push({ kind, target: device?.id, args, options: { ...options } });
    return queued.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
  };
  return {
    calls,
    answer: (answer) => {
      queued.push(toResult(answer));
    },
    executable: async () => 'hdc',
    launch: async (args, options) => record('launch', undefined, args, options ?? {}),
    run: async (device, args, options) => record('run', device, args, options ?? {}),
    runShell: async (device, words, options) =>
      record('runShell', device, [...words], options ?? {}),
  };
}

/** Fills the parts of a host answer a test does not name: exit code 0 and empty streams. */
/**
 * Rewrites the stdout of the shell reads a test names, while still recording the call. Use it when
 * a test is about the answer a module gets; assert on `calls` for the argv behind it.
 */
export function answerHarmonyShell(
  stub: HarmonyHdcRunnerStub,
  answer: (words: readonly unknown[]) => string | undefined,
): void {
  const runShell = stub.runShell;
  stub.runShell = async (device, words, options) => {
    const result = await runShell(device, words, options);
    const stdout = answer(words);
    return stdout === undefined ? result : { ...result, stdout };
  };
}

function toResult(
  answer?: Partial<HarmonyCommandResult> & Readonly<{ stdout?: string }>,
): HarmonyCommandResult {
  return {
    stdout: answer?.stdout ?? '',
    stderr: answer?.stderr ?? '',
    exitCode: answer?.exitCode ?? 0,
  };
}
