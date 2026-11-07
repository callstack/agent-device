import path from 'node:path';

import { runCmd, runCmdBackground } from '@agent-device/host-kit/command';
import { Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import { AppError, asAppError, errorMessage } from '@agent-device/kernel/errors';
import { listTargets, type PageTunnel } from '@agent-device/tv-cdp';

export type AresDevice = Readonly<{
  name: string;
  /** The TV endpoint the entry reaches, the same for every entry that names that TV. */
  endpoint: string;
  isDefault: boolean;
}>;

type AresSetupEntry = {
  profile: string;
  name: string;
  default: boolean;
  // ares lists an SSH entry with its IP and port, and a USB (novacom) entry with neither.
  deviceinfo: { ip: string; port: string } | { ip?: undefined };
};

export type HostEnv = Readonly<Record<string, string | undefined>>;

export function createAres(bin: string | undefined, hostEnv: HostEnv) {
  const command = (name: string) => (bin ? path.resolve(bin, name) : name);
  const env = bin
    ? { ...hostEnv, PATH: [bin, hostEnv.PATH].filter(Boolean).join(path.delimiter) }
    : hostEnv;
  const ares = async (name: string, args: string[], signal?: AbortSignal) => {
    try {
      return (await runCmd(command(name), args, { env, timeoutMs: 60_000, signal })).stdout;
    } catch (error) {
      throw aresError(name, error);
    }
  };

  const forDevice = (device: string) => ({
    async launch(appId: string, signal?: AbortSignal) {
      await ares('ares-launch', ['-d', device, appId], signal);
    },

    async close(appId: string, signal?: AbortSignal) {
      await ares('ares-launch', ['-d', device, '--close', appId], signal);
    },

    async listApps(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
      return parseAppList(await ares('ares-install', ['-d', device, '--listfull'], signal));
    },

    // ares-inspect is a long-lived ssh tunnel that prints its local inspector port once it is up.
    // The page target only appears once the app has loaded, so the port alone is not enough.
    async inspect(appId: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<PageTunnel> {
      // The tunnel outlives this request, so the signal only cancels the wait for the page.
      const { child, wait } = runCmdBackground(
        command('ares-inspect'),
        ['-d', device, '-a', appId],
        {
          env,
          captureOutput: false,
        },
      );
      let output = '';
      let collecting = true;
      let spawnError: unknown;
      let inspectorError: unknown;
      const collect = (chunk: Buffer) => {
        if (collecting) output += chunk;
      };
      wait.catch((error: unknown) => {
        if (child.pid === undefined) spawnError = error;
      });
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else {
          child.once('exit', () => resolve());
          child.once('error', () => resolve());
        }
      });
      const close = async () => {
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
        forceKill.unref();
        try {
          await exited;
        } finally {
          clearTimeout(forceKill);
        }
      };
      const appTarget = async (port: number) => {
        try {
          const targets = await listTargets(port);
          return targets.find((target) => target.url.includes(`/${appId}/`));
        } catch (error) {
          inspectorError = error;
          return undefined;
        }
      };

      const { value: target } = await pollUntilSettled({
        deadline: Deadline.fromTimeoutMs(timeoutMs),
        intervalMs: 500,
        signal,
        settled: (found) => found !== undefined,
        probe: async () => {
          if (spawnError) throw aresError('ares-inspect', spawnError);
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new AppError('COMMAND_FAILED', `ares-inspect exited: ${output.trim()}`, {
              hint: `Check that ${device} is reachable with ares-setup-device and in Developer Mode.`,
            });
          }
          const port = Number(output.match(/localhost:(\d+)/)?.[1]);
          return port ? await appTarget(port) : undefined;
        },
      }).catch(async (error: unknown) => {
        await close();
        throw error;
      });
      if (target) {
        collecting = false;
        return { target, close, onClose: (listener) => child.once('exit', listener) };
      }
      await close();
      const lastError = inspectorError
        ? `; the inspector last failed with: ${errorMessage(inspectorError)}`
        : '';
      throw new AppError(
        'COMMAND_FAILED',
        `ares-inspect found no page for ${appId} on ${device} within ${timeoutMs}ms${lastError}`,
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
          endpoint: aresEndpoint(device),
          isDefault: device.default,
        }));
    },
    forDevice,
  };
}

// Two entries can name one TV, so the TV is the address the entry reaches, not the entry.
function aresEndpoint({ name, deviceinfo }: AresSetupEntry) {
  return deviceinfo.ip ? `${deviceinfo.ip}:${deviceinfo.port}` : name;
}

function aresError(name: string, error: unknown): AppError {
  const failure = asAppError(error, 'COMMAND_FAILED');
  if (failure.code === 'TOOL_MISSING') {
    return new AppError('TOOL_MISSING', `${name} is not installed or not on PATH`, {
      hint: 'Install the webOS CLI (npm install -g @webos-tools/cli), or set the plugin option aresBin to the directory that holds it.',
    });
  }
  if (failure.details?.processExitError !== true) return failure;
  const stderr = typeof failure.details?.stderr === 'string' ? failure.details.stderr.trim() : '';
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
