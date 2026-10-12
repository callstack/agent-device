import crypto from 'node:crypto';
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
import { vi } from 'vitest';
import { createAgentBrowserWebProvider } from '../agent-browser-provider.ts';
import type { WebProvider } from '../provider.ts';

const TEST_AGENT_BROWSER_VERSION = '0.27.1';

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

type FakeManagedAgentBrowserInstall = ReturnType<typeof expectedManagedAgentBrowserInstall>;

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
  await testFn(createAgentBrowserWebProvider({ ...options, stateDir }));
}

/** The answer shape the managed backend answers every command with. */
export function agentBrowserJsonResult(value: unknown, exitCode = 0): ExecResult {
  return { stdout: JSON.stringify(value), stderr: '', exitCode };
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

export function installFakeManagedAgentBrowser(stateDir: string): FakeManagedAgentBrowserInstall {
  const install = writeFakeManagedAgentBrowserPackage(stateDir);
  fs.writeFileSync(path.join(install.installDir, 'manifest.json'), '{}');
  return install;
}

/** The package tree `npm install` leaves behind, without the setup manifest. */
export function writeFakeManagedAgentBrowserPackage(
  stateDir: string,
): FakeManagedAgentBrowserInstall {
  const install = expectedManagedAgentBrowserInstall(stateDir);
  fs.mkdirSync(path.dirname(install.entryScript), { recursive: true });
  fs.writeFileSync(install.entryScript, 'process.exit(0)\n');
  // npm links a console shim beside the package; the fixture carries it so tests
  // prove the shim is never spawned rather than merely absent (#2022).
  fs.mkdirSync(path.dirname(install.binaryPath), { recursive: true });
  fs.writeFileSync(install.binaryPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(install.binaryPath, 0o755);
  fs.writeFileSync(
    path.join(install.packageDir, 'package.json'),
    JSON.stringify({
      name: 'agent-browser',
      version: TEST_AGENT_BROWSER_VERSION,
      bin: { 'agent-browser': './dist/cli.js' },
    }),
  );
  return install;
}

/** npm's own JS launcher, for tests that drive managed setup without a real npm. */
export function writeFakeNpmCliScript(root: string): string {
  const npmCliScript = path.join(root, 'node runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(npmCliScript), { recursive: true });
  fs.writeFileSync(npmCliScript, 'process.exit(0)\n');
  return npmCliScript;
}

/** Reports a different Node runtime to the code under test for one scenario. */
export async function withNodeRuntime(
  overrides: { version?: string; platform?: NodeJS.Platform; execPath?: string },
  testFn: () => void | Promise<void>,
): Promise<void> {
  const restore: (() => void)[] = [];
  const override = (target: object, key: string, value: unknown) => {
    const original = (target as Record<string, unknown>)[key];
    Object.defineProperty(target, key, { value, configurable: true });
    restore.push(() => Object.defineProperty(target, key, { value: original, configurable: true }));
  };
  if (overrides.version !== undefined) {
    override(process.versions, 'node', overrides.version);
    override(process, 'version', `v${overrides.version}`);
  }
  if (overrides.platform !== undefined) override(process, 'platform', overrides.platform);
  if (overrides.execPath !== undefined) override(process, 'execPath', overrides.execPath);
  try {
    await testFn();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

function expectedManagedAgentBrowserInstall(stateDir: string) {
  const installDir = path.join(stateDir, 'tools', 'agent-browser', TEST_AGENT_BROWSER_VERSION);
  const packageDir = path.join(installDir, 'package', 'node_modules', 'agent-browser');
  return {
    version: TEST_AGENT_BROWSER_VERSION,
    installDir,
    packageDir,
    binaryPath: path.join(
      installDir,
      'package',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser',
    ),
    entryScript: path.join(packageDir, 'dist', 'cli.js'),
    homeDir: path.join(installDir, 'home'),
    runtimeHomeDir:
      process.platform === 'win32'
        ? path.join(installDir, 'home')
        : path.join(os.tmpdir(), 'agent-device-web', sha1Short(installDir)),
    socketDir: path.join(os.tmpdir(), 'adw', sha1Short(installDir)),
  };
}

function sha1Short(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}
