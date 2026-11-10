import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- real Unix socket path under TMPDIR (104-char limit)
import os from 'node:os';
import path from 'node:path';
import {
  type CommandExecutorOverride,
  type ExecOptions,
  type ExecResult,
} from '@agent-device/host-kit/command';
import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { installFakeManagedAgentBrowser } from '@agent-device/test-kit';
import { vi } from 'vitest';
import { createAgentBrowserWebProvider } from '../agent-browser-provider.ts';
import type { WebProvider } from '../provider.ts';

export function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export type RecordedCommand = Readonly<{
  command: string;
  args: readonly string[];
  options: ExecOptions;
}>;

export type FailNthCommandExecutor = Readonly<{
  override: CommandExecutorOverride;
  calls: () => readonly RecordedCommand[];
}>;

export function createFailNthCommandExecutor(
  nthCall: number,
  failure: unknown = new Error('injected command failure'),
): FailNthCommandExecutor {
  if (!Number.isSafeInteger(nthCall) || nthCall < 1) {
    throw new RangeError('nthCall must be a positive safe integer');
  }

  let callCount = 0;
  const history: RecordedCommand[] = [];
  const override: CommandExecutorOverride = async (command, args, options) => {
    callCount += 1;
    history.push({ command, args: [...args], options: { ...options } });
    if (callCount === nthCall) throw failure;
    return { stdout: JSON.stringify({ success: true, data: {} }), stderr: '', exitCode: 0 };
  };

  return { override, calls: () => history };
}

/**
 * Drives one scenario through the real provider against a managed install whose CLI answers come
 * from the caller's command-executor override, in a state dir of its own. Tests that only need the
 * CLI answers leave `options` empty: without an owned-process record store the provider keeps no
 * fleet record, so no scenario pays for or trips over a real process-table read.
 */
export async function withManagedAgentBrowserProvider(
  options: {
    session?: string;
    openWebSessionNames?: () => readonly string[];
    ownedProcessRecords?: OwnedProcessRecordStore;
  },
  testFn: (provider: WebProvider) => void | Promise<void>,
): Promise<void> {
  const stateDir = mkdtempForTestSync('agent device web provider ');
  installFakeManagedAgentBrowser(stateDir);
  await testFn(
    createAgentBrowserWebProvider({
      host: { env: process.env, cwd: process.cwd() },
      ...options,
      stateDir,
    }),
  );
}

/** The answer shape the managed backend answers every command with. */
export function agentBrowserJsonResult(value: unknown, exitCode = 0): ExecResult {
  return { stdout: JSON.stringify(value), stderr: '', exitCode };
}

/** A web provider whose every operation succeeds with nothing; a test overrides the ones it reads. */
export function makeWebProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}

/** A fleet record store that records what was asked of it and holds nothing. */
export function ownedProcessRecordStore(): OwnedProcessRecordStore {
  return { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
}

/**
 * Strips the `node <entry>` prefix the backend is spawned with, so a test reads the agent-browser
 * CLI arguments it is about. The spawn shape itself is owned and asserted by agent-browser-tool.
 */
export function managedAgentBrowserCliArgs(args: readonly string[]): string[] {
  return args.slice(1);
}

export type ManagedAgentBrowserExecutor = {
  override: CommandExecutorOverride;
  /** The agent-browser CLI arguments the provider asked for, in order, prefix stripped. */
  commands: () => string[][];
};

/** Answers every managed command with success and remembers the agent-browser arguments. */
export function recordingAgentBrowserExecutor(): ManagedAgentBrowserExecutor {
  const commands: string[][] = [];
  return {
    commands: () => commands,
    override: async (_command, args) => {
      commands.push(managedAgentBrowserCliArgs(args));
      return agentBrowserJsonResult({ success: true, data: {} });
    },
  };
}

/** npm's own JS launcher, for tests that drive managed setup without a real npm. */
export function writeFakeNpmCliScript(root: string): string {
  const npmCliScript = path.join(root, 'node runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(npmCliScript), { recursive: true });
  fs.writeFileSync(npmCliScript, 'process.exit(0)\n');
  return npmCliScript;
}
