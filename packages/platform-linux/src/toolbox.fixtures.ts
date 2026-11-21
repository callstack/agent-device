import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { PlatformHost } from 'agent-device/plugins';
import type { LinuxCommandResult, LinuxDetachedExit } from '@agent-device/contracts/linux-tool-provider';
import { createLinuxToolbox, type LinuxToolbox } from './toolbox.ts';

/** One command this stubbed host was asked to run, plus the environment it was handed. */
export type LinuxHostStubCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env: HostEnvironment['env'] | undefined;
  timeoutMs: number | undefined;
  allowFailure: boolean | undefined;
  stdin: string | undefined;
  signal: AbortSignal | undefined;
}>;

/** One detached launch the plugin asked the host to start. */
export type LinuxHostStubLaunch = Readonly<{
  executable: string;
  args: readonly string[];
  env: HostEnvironment['env'] | undefined;
}>;

export type LinuxHostStub = Readonly<{
  toolbox: LinuxToolbox;
  host: PlatformHost;
  /** Every command the plugin asked the host to run, in order. */
  commands: LinuxHostStubCommand[];
  /** Every detached launch the plugin asked the host to start, in order. */
  launches: LinuxHostStubLaunch[];
  /** Every diagnostic the plugin recorded through the host, in order. */
  diagnostics: LinuxHostDiagnostic[];
  /** Queues one answer for the next command; exit code 0 is the common case. */
  answer(answer?: Partial<LinuxCommandResult> & Readonly<{ stdout?: string }>): void;
  /** Queues one exit for the next detached launch. */
  answerLaunch(exit: LinuxDetachedExit): void;
}>;

/** One family diagnostic the plugin recorded through the host. */
export type LinuxHostDiagnostic = Readonly<{
  level: string;
  phase: string;
  data: Record<string, unknown>;
}>;

const NO_ANSWER: LinuxCommandResult = Object.freeze({
  stdout: '',
  stderr: 'linux-host-stub: no answer queued',
  exitCode: 1,
});

/**
 * Binds the plugin's toolbox to an in-memory host for colocated unit tests: nothing spawns, and
 * every command and detached launch the plugin asks for is recorded with the environment the plugin
 * built. Tests assert on the argv and on which tools the host reported, which is what this family's
 * tool contract is.
 */
export function createLinuxHostStub(
  input: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    /** Tools the host can execute. When set, `isFileExecutable` answers from it alone. */
    tools?: Iterable<string>;
    /** Answers one command. Takes precedence over the queued answers. */
    respond?: (
      executable: string,
      args: readonly string[],
    ) => Partial<LinuxCommandResult> & Readonly<{ stdout?: string }>;
    /** Rejected one command, the way the host rejects a spawn it cannot start. */
    reject?: (executable: string, args: readonly string[]) => Error;
    /** Answers a detached launch. Takes precedence over the queued exits. */
    launchExit?: (executable: string, args: readonly string[]) => LinuxDetachedExit;
  }> = {},
): LinuxHostStub {
  const env = input.env ?? { PATH: '/usr/bin' };
  const tools = input.tools ? new Set(input.tools) : undefined;
  const commands: LinuxHostStubCommand[] = [];
  const launches: LinuxHostStubLaunch[] = [];
  const answers: LinuxCommandResult[] = [];
  const launchExits: LinuxDetachedExit[] = [];
  const diagnostics: LinuxHostDiagnostic[] = [];
  const host = Object.freeze({
    env,
    cwd: '/host-cwd',
    stateDir: '/host-state',
    emitDiagnostic: (event: LinuxHostDiagnostic) => {
      diagnostics.push(event);
    },
    withDiagnosticTimer: async (_phase: string, operation: () => Promise<unknown>) =>
      await operation(),
    // The availability probe the plugin is allowed to make: the tool list stands in for the host's
    // `PATH`, so a test states which desktop tools exist rather than writing executables.
    isFileExecutable: async (candidate: string) =>
      tools === undefined ? false : tools.has(path.basename(candidate)),
    runCommand: async (
      executable: string,
      args: string[],
      options: {
        env?: Readonly<Record<string, string>>;
        timeoutMs?: number;
        allowFailure?: boolean;
        stdin?: string;
        signal?: AbortSignal;
      },
    ): Promise<LinuxCommandResult> => {
      commands.push({
        executable,
        args,
        env: options.env,
        timeoutMs: options.timeoutMs,
        allowFailure: options.allowFailure,
        stdin: options.stdin,
        signal: options.signal,
      });
      if (input.reject) throw input.reject(executable, args);
      if (input.respond) return toResult(input.respond(executable, args));
      return answers.shift() ?? NO_ANSWER;
    },
    launchDetached: async (
      executable: string,
      args: string[],
      options: { env?: Readonly<Record<string, string>> },
    ) => {
      launches.push({ executable, args, env: options.env });
      const queued =
        input.launchExit?.(executable, args) ?? launchExits.shift() ?? { pid: 1, exitCode: 0 };
      return { pid: queued.pid, exited: Promise.resolve(queued) };
    },
  }) as unknown as PlatformHost;
  return Object.freeze({
    toolbox: createLinuxToolbox(host),
    host,
    commands,
    launches,
    diagnostics,
    answer: (answer) => {
      answers.push(toResult(answer));
    },
    answerLaunch: (exit) => {
      launchExits.push(exit);
    },
  });
}

/** The provider built on the stub host, with one semantic part replaced. */
export function createLinuxToolboxWith(
  toolbox: LinuxToolbox,
  overrides: Readonly<{ commands?: LinuxToolbox['commands'] }>,
): LinuxToolbox {
  return Object.freeze({ ...toolbox, ...overrides });
}

/**
 * A directory holding one executable stand-in tool, for the tests that need the host to resolve a
 * bare name through a real `PATH` rather than through a stated tool list.
 */
export function createLinuxToolDirectory(
  name: string,
  contents = '#!/bin/sh\nexit 0\n',
): string {
  const root = mkdtempForTestSync(`linux-tool-${name}-`);
  fs.writeFileSync(path.join(root, name), contents, { mode: 0o755 });
  return root;
}

/** One command the plugin asked the host to run, as `[executable, args]`. */
export function linuxCommandTuple(
  command: LinuxHostStubCommand,
): [string, readonly string[]] {
  return [command.executable, command.args];
}

function toResult(answer: (Partial<LinuxCommandResult> & { stdout?: string }) | undefined) {
  return Object.freeze({
    stdout: answer?.stdout ?? '',
    stderr: answer?.stderr ?? '',
    exitCode: answer?.exitCode ?? 0,
  });
}
