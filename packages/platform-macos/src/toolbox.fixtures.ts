import { accessSync, constants } from 'node:fs';
import type { PlatformHost } from 'agent-device/plugins';
import type {
  MacOsBackgroundProcess,
  MacOsCommandOptions,
  MacOsCommandResult,
  MacOsHostProvider,
  MacOsLeafTools,
} from '@agent-device/contracts/macos-platform-leaf';
import { acquireProcessLock, withProcessLock } from '@agent-device/host-kit/file';
import { listHostProcesses, readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { MacOsToolbox } from './toolbox.ts';

type RunCommand = (
  cmd: string,
  args: string[],
  options?: MacOsCommandOptions,
) => Promise<MacOsCommandResult>;

/** One diagnostic the plugin recorded through the host. */
export type MacOsHostDiagnostic = Readonly<{
  level?: string;
  phase: string;
  data?: Record<string, unknown>;
}>;

export type MacOsToolboxFixture = MacOsToolbox &
  Readonly<{
    /** Every diagnostic the plugin recorded through the host, in order. */
    diagnostics: MacOsHostDiagnostic[];
    /** Every lock the plugin asked the host to hold, in order. */
    locks: { lockDirPath: string; timeoutMs: number; signal?: AbortSignal }[];
    /** Every background command the plugin started, in order. */
    background: { cmd: string; args: string[] }[];
  }>;

const unexpectedCommand: RunCommand = async (cmd, args) => {
  throw new Error(`macos-toolbox-fixture: unexpected command ${[cmd, ...args].join(' ')}`);
};

/**
 * Binds the plugin's operations to an in-memory host and to the Apple tools a test names, the way
 * the Apple owner hands them in for one request. Nothing spawns unless the test's own `runCommand`
 * does. Naming any tool marks the toolbox as scoped, exactly as a request that scopes its Apple
 * tools is.
 */
export function macOsToolboxFixture(
  input: Readonly<{
    runCommand?: RunCommand;
    macosHelper?: {
      run(args: string[], options?: MacOsCommandOptions): Promise<MacOsCommandResult>;
    };
    macosHost?: MacOsHostProvider;
    plist?: { readJson(path: string): Promise<Record<string, unknown> | null> };
    scoped?: boolean;
    hostOs?: PlatformHost['hostOs'];
    /** Receives every diagnostic as well, for a test that asserts on a spy. */
    emitDiagnostic?: (event: MacOsHostDiagnostic) => void;
  }> = {},
): MacOsToolboxFixture {
  const runCommand = input.runCommand ?? unexpectedCommand;
  const diagnostics: MacOsHostDiagnostic[] = [];
  const locks: MacOsToolboxFixture['locks'] = [];
  const background: MacOsToolboxFixture['background'] = [];
  const tools: MacOsLeafTools = {
    runCommand,
    listProcesses: async ({ timeoutMs }) =>
      await listHostProcesses({
        runCommand: async (cmd, args, options) =>
          await runCommand(cmd, args, {
            timeoutMs: options.timeoutMs,
            allowFailure: options.allowFailure,
          }),
        timeoutMs,
      }),
    startBackground: async (cmd, args): Promise<MacOsBackgroundProcess> => {
      background.push({ cmd, args });
      return {
        pid: 4242,
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
        terminate: async () => {},
      };
    },
    ...(input.macosHelper ? { helper: input.macosHelper } : {}),
    ...(input.macosHost ? { host: input.macosHost } : {}),
    readPlistJson: async (plistPath) => {
      if (input.plist) return await input.plist.readJson(plistPath);
      const result = await runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath], {
        allowFailure: true,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) return null;
      return JSON.parse(result.stdout) as Record<string, unknown>;
    },
    scoped:
      input.scoped ??
      (input.runCommand !== undefined ||
        input.macosHelper !== undefined ||
        input.macosHost !== undefined),
  };
  const host = {
    env: {},
    cwd: '/',
    stateDir: '/fixture-state',
    hostOs: input.hostOs ?? 'darwin',
    emitDiagnostic: (event: MacOsHostDiagnostic) => {
      diagnostics.push(event);
      input.emitDiagnostic?.(event);
    },
    isFileExecutable: async (candidate: string) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    processes: {
      withLock: async <T>(params: {
        lockDirPath: string;
        timeoutMs: number;
        signal?: AbortSignal;
        task: () => Promise<T>;
      }) => {
        locks.push({
          lockDirPath: params.lockDirPath,
          timeoutMs: params.timeoutMs,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        // The real host lock, taken the way the core's plugin host takes it.
        return await withProcessLock({
          acquire: async () =>
            await acquireProcessLock({
              lockDirPath: params.lockDirPath,
              owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
              timeoutMs: params.timeoutMs,
              ...(params.signal ? { signal: params.signal } : {}),
            }),
          task: params.task,
        });
      },
    },
  } as unknown as PlatformHost;
  return { host, tools, diagnostics, locks, background };
}
