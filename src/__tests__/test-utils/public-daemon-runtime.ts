import type {
  CreateDaemonCommandSurface,
  DaemonCommandSurface,
  DaemonWaitResult,
  DaemonWaitTarget,
} from '@agent-device/contracts/daemon-command-surface';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import { AppError } from '@agent-device/kernel/errors';
import { startDaemonRuntime, type DaemonRuntimeController } from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import fs from 'node:fs';
import { createDaemonRuntimeDeps } from '../../daemon-composition.ts';
import { currentDaemonCodeSignature } from './daemon-http-fixture.ts';

export type PublicDaemonRuntimeFixture = Readonly<{
  stateDir: string;
  baseUrl: string;
  runtime: DaemonRuntimeController;
  close: () => Promise<void>;
}>;

export async function startPublicDaemonRuntime(
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    serverMode?: 'http' | 'socket' | 'dual';
    createCommandSurface?: CreateDaemonCommandSurface;
  } = {},
): Promise<PublicDaemonRuntimeFixture> {
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = options.stateDir ?? mkdtempForTestSync('agent-device-public-daemon-');
  const runtime = await startDaemonRuntime({
    composeDeps: async (input) => {
      const deps = await createDaemonRuntimeDeps(input);
      return options.createCommandSurface
        ? {
            ...deps,
            requestRouter: {
              ...deps.requestRouter,
              createCommandSurface: options.createCommandSurface,
            },
          }
        : deps;
    },
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        ...options.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: options.serverMode ?? 'dual',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    }),
    exit: () => {},
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  if (!runtime) throw new Error('The public daemon runtime did not start.');
  try {
    const paths = resolveDaemonPaths(stateDir);
    const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({ ...info, codeSignature: currentDaemonCodeSignature() })}\n`,
    );
    const port = runtime.httpPort ?? runtime.socketPort;
    if (port === undefined) {
      throw new Error('The public daemon runtime published no transport port.');
    }
    return {
      stateDir,
      baseUrl: `http://127.0.0.1:${port}`,
      runtime,
      close: async () => {
        await runtime.shutdown();
        fs.rmSync(stateDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.shutdown().catch(() => {});
    if (ownsStateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
}

export function createPublicWaitCommandSurface(
  options: {
    onStarted?: (target: DaemonWaitTarget, requestId?: string) => void;
    onCanceled?: (target: DaemonWaitTarget, requestId?: string) => void;
    fail?: boolean;
  } = {},
): CreateDaemonCommandSurface {
  return async (config: AgentDeviceRuntimeConfig): Promise<DaemonCommandSurface> => ({
    signal: config.signal,
    capture: {} as DaemonCommandSurface['capture'],
    selectors: {
      wait: async ({ target, requestId }): Promise<DaemonWaitResult> => {
        if (options.fail) {
          throw new AppError('COMMAND_FAILED', 'REMOTE_RECORD_SENTINEL');
        }
        if (target.kind === 'sleep' && target.durationMs <= 1) {
          return { kind: 'sleep', waitedMs: target.durationMs };
        }
        options.onStarted?.(target, requestId);
        const signal = config.signal;
        if (!signal) throw new Error('The daemon did not inject the request signal.');
        if (signal.aborted) {
          options.onCanceled?.(target, requestId);
          throw signal.reason;
        }
        return await new Promise<DaemonWaitResult>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              options.onCanceled?.(target, requestId);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    } as DaemonCommandSurface['selectors'],
    interactions: {} as DaemonCommandSurface['interactions'],
  });
}
