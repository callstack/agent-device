import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceBootHookRun,
  DeviceReadinessRuntimeHost,
} from '@agent-device/contracts/device-readiness-runtime';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { isCommandTimeoutError, runCmd } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

const BOOT_HOOK_FILE = 'boot-hook.json';
const BOOT_HOOK_TIMEOUT_MS = 300_000;
const BOOT_HOOK_TERM_GRACE_MS = 10_000;

type BootHook = Readonly<{ command: readonly [string, ...string[]]; cwd?: string }>;

function invalidHook(file: string, problem: string): AppError {
  return new AppError('INVALID_ARGS', `Invalid device boot hook ${file}: ${problem}`, {
    reason: 'invalid_boot_hook',
    hint: `Fix or remove ${file}. Without it, agent-device boots shut-down devices itself.`,
  });
}

function readBootHookText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw invalidHook(file, error instanceof Error ? error.message : String(error));
  }
}

function parseJsonObject(file: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidHook(file, 'it is not JSON');
  }
  if (!isRecord(parsed)) throw invalidHook(file, 'it is not a JSON object');
  return parsed;
}

function hookCommand(file: string, value: unknown): BootHook['command'] {
  const parts = Array.isArray(value) ? value : [];
  const argv = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  const [executable, ...args] = argv;
  if (executable === undefined || argv.length !== parts.length) {
    throw invalidHook(file, 'command must be a non-empty array of non-empty strings');
  }
  return [executable, ...args];
}

function readBootHook(file: string): BootHook | null {
  const text = readBootHookText(file);
  if (text === null) return null;
  const parsed = parseJsonObject(file, text);
  const unknown = Object.keys(parsed).filter((key) => key !== 'command' && key !== 'cwd');
  if (unknown.length > 0) throw invalidHook(file, `unknown key ${unknown.join(', ')}`);
  const command = hookCommand(file, parsed.command);
  const { cwd } = parsed;
  if (cwd === undefined) return { command };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw invalidHook(file, 'cwd must be an absolute path');
  }
  return { command, cwd };
}

const HOOK_OUTPUT_TAIL_CHARS = 2_000;

function leftDeviceDown(run: DeviceBootHookRun, device: DeviceInfo): AppError {
  const output = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n');
  return new AppError(
    'COMMAND_FAILED',
    `The device boot hook (${run.command.join(' ')}) ${run.failure ?? `exited ${run.exitCode}`} and left ${device.name} (${device.id}) not booted. agent-device does not boot a device itself while a boot hook is configured.${output ? ` Hook output:\n${output.slice(-HOOK_OUTPUT_TAIL_CHARS)}` : ''}`,
    {
      reason: 'boot_hook_left_device_down',
      hook: run.command,
      exitCode: run.exitCode,
      deviceId: device.id,
      hint: "Follow the remedy in the hook's output. The hook's tool owns this device's boot.",
    },
  );
}

function hookTimeoutMs(deadlineAtMs: number | undefined): number {
  if (deadlineAtMs === undefined) return BOOT_HOOK_TIMEOUT_MS;
  return Math.min(BOOT_HOOK_TIMEOUT_MS, Math.max(1_000, deadlineAtMs - Date.now()));
}

function hookFailure(file: string, error: unknown, timeoutMs: number): string {
  if (isCommandTimeoutError(error)) return `ran past its ${timeoutMs} ms limit and was stopped`;
  const message = error instanceof Error ? error.message : String(error);
  return `could not run from ${file} (${message})`;
}

export function createDeviceBootHook(
  host: HostEnvironment,
): DeviceReadinessRuntimeHost['bootHook'] {
  const file = path.join(
    resolveDaemonPaths(host.env.AGENT_DEVICE_STATE_DIR, { env: host.env, cwd: host.cwd }).baseDir,
    BOOT_HOOK_FILE,
  );
  return Object.freeze({
    leftDeviceDown,
    run: async (device, signal, options = {}): Promise<DeviceBootHookRun | null> => {
      const hook = readBootHook(file);
      if (!hook) return null;
      const [executable, ...args] = hook.command;
      const platform = publicPlatformString(device);
      const timeoutMs = hookTimeoutMs(options.deadlineAtMs);
      emitDiagnostic({
        phase: 'device_boot_hook_start',
        data: { command: hook.command, deviceId: device.id, platform, timeoutMs },
      });
      const started = Date.now();
      const cwd = hook.cwd ?? host.cwd;
      let run: DeviceBootHookRun;
      try {
        if (!fs.existsSync(cwd)) throw new Error(`its cwd ${cwd} does not exist`);
        const result = await runCmd(executable, args, {
          cwd,
          env: {
            ...host.env,
            AGENT_DEVICE_BOOT_HOOK_PLATFORM: platform,
            AGENT_DEVICE_BOOT_HOOK_DEVICE_ID: device.id,
            AGENT_DEVICE_BOOT_HOOK_DEVICE_NAME: device.name,
          },
          allowFailure: true,
          timeoutMs,
          signal,
          kill: { signal: 'SIGTERM', graceMs: BOOT_HOOK_TERM_GRACE_MS },
        });
        run = {
          command: hook.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        signal?.throwIfAborted();
        const details = isRecord(error) && isRecord(error.details) ? error.details : {};
        run = {
          command: hook.command,
          exitCode: null,
          failure: hookFailure(file, error, timeoutMs),
          stdout: typeof details.stdout === 'string' ? details.stdout : '',
          stderr: typeof details.stderr === 'string' ? details.stderr : '',
        };
      }
      emitDiagnostic({
        level: run.exitCode === 0 ? 'info' : 'warn',
        phase: 'device_boot_hook_exit',
        durationMs: Date.now() - started,
        data: {
          command: hook.command,
          exitCode: run.exitCode,
          failure: run.failure,
          stderr: run.stderr,
        },
      });
      return run;
    },
  });
}
