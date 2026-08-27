import type {
  DeviceInventoryHost,
  HostOperatingSystem,
  HostCommandRequest,
  HostTemporaryTextFile,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppleToolHost } from './platform-runtime-apple-tool-host.ts';
import { createHostToolchainPreparer } from './platform-runtime-toolchain-host.ts';
import { runCmd, whichCmd } from '@agent-device/host-kit/command';

export function createDeviceInventoryHost(): DeviceInventoryHost {
  return Object.freeze({
    commands: Object.freeze({
      which: async (executable: string) => ((await whichCmd(executable)) ? executable : undefined),
      run: async (request: HostCommandRequest, signal?: AbortSignal) => {
        const result = await runCmd(request.executable, [...request.args], {
          allowFailure: request.allowFailure,
          cwd: request.cwd,
          env: request.env ? { ...process.env, ...request.env } : undefined,
          signal,
          timeoutMs: request.timeoutMs,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
    }),
    appleTools: createAppleToolHost(),
    toolchains: createHostToolchainPreparer(),
    files: Object.freeze({
      isExecutable: async (candidate: string) => await isExecutable(candidate),
      createTemporaryTextFile: async (options: { prefix: string; suffix: string }) =>
        await createTemporaryTextFile(options),
    }),
    hostOs: hostOperatingSystem(process.platform),
    hostName: os.hostname(),
    homeDirectory: os.homedir(),
    observations: Object.freeze({
      deviceBooted: async (device: DeviceInfo) => {
        const { markSimulatorBooted } = await import('./platforms/apple/core/simulator.ts');
        markSimulatorBooted(device);
      },
    }),
  });
}

function hostOperatingSystem(platform: NodeJS.Platform): HostOperatingSystem {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  return 'other';
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function createTemporaryTextFile(
  options: Readonly<{
    prefix: string;
    suffix: string;
  }>,
): Promise<HostTemporaryTextFile> {
  const directory = await mkdtemp(path.join(os.tmpdir(), options.prefix));
  const filePath = path.join(directory, `value${options.suffix}`);
  let disposed = false;
  return {
    path: filePath,
    readText: async () => await readFile(filePath, 'utf8'),
    writeText: async (value: string) => await writeFile(filePath, value, 'utf8'),
    [Symbol.asyncDispose]: async () => {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
