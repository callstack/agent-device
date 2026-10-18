import type { HostEnvironment } from '@agent-device/kernel/source-value';
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
import { guardedHostCommandArgv } from './platform-runtime-host-device-shell.ts';
import { hostHomeDirectoryFromEnv } from '@agent-device/host-kit/host-file';

export function createDeviceInventoryHost(host: HostEnvironment): DeviceInventoryHost {
  const env = host.env;
  // The host names its own home; families derive default-install paths from it (#3794). A host
  // that names none (HOME and USERPROFILE both absent, e.g. env -i or a systemd unit without
  // User=) yields undefined, and each family then omits only the home-derived default paths.
  // Guessing the process home would be an ambient read (#3753), so undefined is the honest answer.
  const homeDirectory = hostHomeDirectoryFromEnv(env);
  return Object.freeze({
    commands: Object.freeze({
      which: async (executable: string) =>
        (await whichCmd(executable, env)) ? executable : undefined,
      run: async (request: HostCommandRequest, signal?: AbortSignal) => {
        const result = await runCmd(request.executable, guardedHostCommandArgv(request), {
          allowFailure: request.allowFailure,
          cwd: request.cwd,
          env: request.env ? { ...env, ...request.env } : undefined,
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
    toolchains: createHostToolchainPreparer(env),
    files: Object.freeze({
      isExecutable: async (candidate: string) => await isExecutable(candidate),
      createTemporaryTextFile: async (options: { prefix: string; suffix: string }) =>
        await createTemporaryTextFile(options),
    }),
    hostOs: hostOperatingSystem(process.platform),
    hostName: os.hostname(),
    homeDirectory,
    observations: Object.freeze({
      deviceBooted: async (device: DeviceInfo) => {
        const { markSimulatorBooted } = await import('@agent-device/platform-apple/simulator');
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
