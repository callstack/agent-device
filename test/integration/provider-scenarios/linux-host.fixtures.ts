import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlatformHost } from '@agent-device/plugins/contract';
import { createPlatformPluginHost } from '../../../src/platform-runtime/plugin-host.ts';

/** One command the scripted desktop was asked to run, with everything the family asked for. */
export type LinuxScenarioCommand = Readonly<{
  command: string;
  args: readonly string[];
  stdin?: string;
  allowFailure: boolean;
}>;

/** What the scripted desktop answers one command with. */
export type LinuxScenarioAnswer = Readonly<{
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}>;

/**
 * The `PlatformHost` the Linux plugin is set up with, plus the record of what it was asked for.
 *
 * The Linux family answers every desktop intent through the host its `setup` received, so this is the
 * only seam a Provider-backed integration scenario has for the family: the scenario installs it with
 * the plugin's own `setup`, and the real inventory, runtime, interactor and tool plumbing run on it.
 * Nothing here stands in for a family operation — it answers the four ports the family asks of a
 * machine (command route, `PATH` probe, file probe, detached launch) and takes the rest from the
 * core's own plugin host.
 */
export type LinuxScenarioHost = Readonly<{
  /** Pass to the Linux plugin's `setup`. */
  host: PlatformHost;
  /** Every `runCommand` so far, with its argv and stdin, in order. */
  commands: LinuxScenarioCommand[];
  /** Every `runCommand` so far, as `[executable, ...argv]`, in order. */
  toolCalls: Array<[string, ...string[]]>;
  /** Every detached launch so far, as `[executable, ...argv]`, in order. */
  launches: Array<[string, ...string[]]>;
  /** Every path the family probed with `isFilePresent`, in order. */
  probedPaths: string[];
  /** The scratch directory this host names as its state dir; released by `dispose`. */
  stateDir: string;
  dispose: () => Promise<void>;
}>;

export type LinuxScenarioHostOptions = Readonly<{
  /** Executables the `PATH` probe answers present for. */
  tools?: readonly string[];
  /** Environment the family reads its display decision from. */
  env?: Readonly<Record<string, string>>;
  /** Answers one command; a command with no answer succeeds with empty streams. */
  respond?: (command: LinuxScenarioCommand) => LinuxScenarioAnswer;
}>;

export function createLinuxScenarioHost(options: LinuxScenarioHostOptions = {}): LinuxScenarioHost {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-provider-scenario-linux-'));
  const tools = new Set(options.tools ?? []);
  const commands: LinuxScenarioCommand[] = [];
  const toolCalls: Array<[string, ...string[]]> = [];
  const launches: Array<[string, ...string[]]> = [];
  const probedPaths: string[] = [];
  const base = createPlatformPluginHost(
    { env: { PATH: process.env.PATH, ...(options.env ?? {}) }, cwd: process.cwd() },
    stateDir,
  );

  const host: PlatformHost = Object.freeze({
    ...base,
    // The scenario runs on a developer's macOS or Linux runner and still drives the Linux family, so
    // the host names the machine the family is asked to drive.
    hostOs: 'linux',
    runCommand: async (command, args, commandOptions) => {
      const entry: LinuxScenarioCommand = Object.freeze({
        command,
        args: Object.freeze([...args]),
        ...(commandOptions?.stdin === undefined ? {} : { stdin: commandOptions.stdin }),
        allowFailure: commandOptions?.allowFailure === true,
      });
      commands.push(entry);
      toolCalls.push([command, ...args]);
      const answer = options.respond?.(entry) ?? {};
      return {
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? '',
        exitCode: answer.exitCode ?? 0,
      };
    },
    // The desktop's tool list stands in for the host's `PATH`, so a scenario names which desktop
    // tools exist instead of writing executables.
    isExecutableOnPath: async (executable) => tools.has(path.basename(executable)),
    // The one shipped resource the family probes for is its AT-SPI helper; a scenario's host always
    // carries it, which is what the family assumes of a correctly installed package.
    isFilePresent: async (probed) => {
      probedPaths.push(probed);
      return true;
    },
    launchDetached: async (command, args) => {
      launches.push([command, ...args]);
      return { pid: 4242, exited: Promise.resolve({ pid: 4242, exitCode: 0 }) };
    },
  });

  return {
    host,
    commands,
    toolCalls,
    launches,
    probedPaths,
    stateDir,
    dispose: async () => {
      await fs.promises.rm(stateDir, { recursive: true, force: true });
    },
  };
}
