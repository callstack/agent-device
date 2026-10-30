import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { listTargets, type CdpTarget, type PageTunnel } from '@agent-device/tv-cdp';

const run = promisify(execFile);

export type AresDevice = Readonly<{
  name: string;
  isDefault: boolean;
}>;

type AresSetupEntry = {
  profile: string;
  name: string;
  default: boolean;
};

export type HostEnv = Readonly<Record<string, string | undefined>>;

export function createAres(bin: string | undefined, hostEnv: HostEnv) {
  const command = (name: string) => (bin ? path.join(bin, name) : name);
  const env = bin
    ? { ...hostEnv, PATH: [bin, hostEnv.PATH].filter(Boolean).join(path.delimiter) }
    : hostEnv;
  const ares = async (name: string, args: string[]) => {
    try {
      return (await run(command(name), args, { env, timeout: 60_000 })).stdout;
    } catch (error) {
      throw aresError(name, error);
    }
  };

  const forDevice = (device: string) => ({
    async launch(appId: string) {
      await ares('ares-launch', ['-d', device, appId]);
    },

    async close(appId: string) {
      await ares('ares-launch', ['-d', device, '--close', appId]);
    },

    async listApps(): Promise<{ id: string; name: string }[]> {
      return parseAppList(await ares('ares-install', ['-d', device, '--listfull']));
    },

    // ares-inspect is a long-lived ssh tunnel that prints its local inspector port once it is up.
    // The page target only appears once the app has loaded, so the port alone is not enough.
    async inspect(appId: string, timeoutMs = 30_000): Promise<PageTunnel> {
      const child = spawn(command('ares-inspect'), ['-d', device, '-a', appId], { env });
      let output = '';
      let collecting = true;
      let spawnError: unknown;
      const collect = (chunk: Buffer) => {
        if (collecting) output += chunk;
      };
      child.on('error', (error) => (spawnError = error));
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const close = () => child.kill();

      const { value: target } = await pollUntilSettled({
        deadline: Deadline.fromTimeoutMs(timeoutMs),
        intervalMs: 500,
        settled: (found) => found !== undefined,
        probe: async () => {
          if (spawnError) throw aresError('ares-inspect', spawnError);
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new AppError('COMMAND_FAILED', `ares-inspect exited: ${output.trim()}`, {
              hint: `Check that ${device} is reachable with ares-setup-device and in Developer Mode.`,
            });
          }
          const port = Number(output.match(/localhost:(\d+)/)?.[1]);
          return port ? await appTarget(port, appId) : undefined;
        },
      }).catch((error: unknown) => {
        close();
        throw error;
      });
      if (target) {
        collecting = false;
        return { target, close, onClose: (listener) => child.once('exit', listener) };
      }
      close();
      throw new AppError(
        'COMMAND_FAILED',
        `ares-inspect found no page for ${appId} on ${device} within ${timeoutMs}ms`,
        { output: output.trim(), hint: `Check that ${appId} is installed and starts on the TV.` },
      );
    },
  });

  return {
    async listDevices(): Promise<AresDevice[]> {
      const devices: AresSetupEntry[] = JSON.parse(await ares('ares-setup-device', ['--listfull']));
      return devices
        .filter((device) => device.profile === 'tv')
        .map((device) => ({
          name: device.name,
          isDefault: device.default,
        }));
    },
    forDevice,
  };
}

async function appTarget(port: number, appId: string): Promise<CdpTarget | undefined> {
  const targets = await listTargets(port).catch(() => []);
  return targets.find((target) => target.url.includes(`/${appId}/`));
}

function aresError(name: string, error: unknown): AppError {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return new AppError('TOOL_MISSING', `${name} is not installed or not on PATH`, {
      hint: 'Install the webOS CLI (npm install -g @webos-tools/cli), or set the plugin option aresBin to the directory that holds it.',
    });
  }
  const stderr =
    error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : '';
  return new AppError('COMMAND_FAILED', `${name} failed${stderr ? `: ${stderr}` : ''}`, {
    hint: 'Check that the TV is on, in Developer Mode, and registered with ares-setup-device.',
  });
}

// `ares-install --listfull` prints one `key : value` block per app, separated by blank lines.
function parseAppList(output: string) {
  return output.split(/\n\s*\n/).flatMap((block) => {
    const id = block.match(/^id : (.+)$/m)?.[1]?.trim();
    const title = block.match(/^title : (.+)$/m)?.[1]?.trim();
    return id ? [{ id, name: title ?? id }] : [];
  });
}
