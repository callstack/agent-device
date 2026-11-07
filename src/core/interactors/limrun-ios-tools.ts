import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
import { createLimrunSimulatorFiles } from './limrun-ios-files.ts';
import type {
  AppleToolProvider,
  AppleToolExecOptions,
} from '@agent-device/platform-apple/tool-provider';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';

type Session = Parameters<LimrunRuntimeDependencies['ios']['createRunner']>[0];

/** Runs the shared Apple host commands against the lease's simulator. */
export function createLimrunAppleToolProvider(
  session: Session,
  lifetime: AbortSignal,
  requestSignal?: AbortSignal,
): AppleToolProvider {
  const unavailable = async (): Promise<never> => {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'This host tool is unavailable on a Limrun simulator',
    );
  };
  const operation = (options: AppleToolExecOptions = {}) => {
    const deadline =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const signal = AbortSignal.any(
      [
        lifetime,
        options.requestCancellation === 'ignore' ? undefined : requestSignal,
        options.signal,
        deadline,
      ].filter((s): s is AbortSignal => Boolean(s)),
    );
    const abortError = (details: Record<string, unknown> = {}) =>
      deadline?.aborted
        ? new AppError('COMMAND_FAILED', 'Remote simulator operation timed out', {
            timeoutMs: options.timeoutMs,
            ...details,
          })
        : createRequestCanceledError();
    if (signal.aborted) throw abortError();
    return { signal, abortError };
  };
  const runSimctl = async (
    input: readonly string[],
    options: AppleToolExecOptions = {},
  ): Promise<ExecResult> => {
    const args = [...input];
    if (args[0] === '--set') args.splice(0, 2);
    const target = args.indexOf(session.device.id);
    if (target !== -1) args[target] = 'booted';
    const { signal, abortError } = operation(options);
    const execution = session.client.simctl(
      args,
      options.stdin === undefined ? undefined : { stdin: String(options.stdin) },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const onStdout = (chunk: Buffer) => stdoutChunks.push(chunk);
    const onStderr = (chunk: Buffer) => stderrChunks.push(chunk);
    execution.on('stdout', onStdout);
    execution.on('stderr', onStderr);
    try {
      const result = await awaitWithSignal(execution.wait(), signal, () => {
        execution.stop();
        return abortError({
          cmd: 'simctl',
          args,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
        });
      });
      let stdout = result.stdout;
      if (
        args[0] === 'list' &&
        (args.includes('devices') || args.includes('-j') || args.includes('--json')) &&
        result.code === 0
      ) {
        try {
          stdout = normalizeDeviceInventory(stdout, session);
        } catch (error) {
          throw new AppError(
            'COMMAND_FAILED',
            'Invalid simulator device inventory',
            {
              cmd: 'simctl',
              args,
              stdout,
              stderr: result.stderr,
            },
            error,
          );
        }
      }
      if (result.code !== 0 && !options.allowFailure) {
        throw new AppError('COMMAND_FAILED', `xcrun exited with code ${result.code}`, {
          cmd: 'simctl',
          args,
          ...execFailureDetails({ exitCode: result.code, stdout, stderr: result.stderr }),
        });
      }
      return { exitCode: result.code, stdout, stderr: result.stderr };
    } finally {
      execution.off('stdout', onStdout);
      execution.off('stderr', onStderr);
    }
  };
  const { simulatorFiles, readInfoPlist } = createLimrunSimulatorFiles(
    session,
    lifetime,
    requestSignal,
  );
  return {
    simctl: { run: runSimctl },
    devicectl: { run: unavailable },
    runCommand: async (command, args, options) => {
      if (command === 'xcrun' && args[0] === 'simctl')
        return await runSimctl(args.slice(1), options);
      return await unavailable();
    },
    whichCommand: async (command) => command === 'xcrun',
    plist: { readJson: async () => null },
    simulatorScreenshotBackend: 'runner',
    simulatorFiles,
    simulatorApps: {
      readInfoPlist,
      list: async (_device, options) => {
        const { signal, abortError } = operation(options);
        const apps = await awaitWithSignal(session.client.listApps(), signal, () =>
          abortError({ cmd: 'listapps' }),
        );
        if (signal.aborted) throw abortError({ cmd: 'listapps' });
        return {
          type: 'listed',
          apps: apps.map((app) => ({
            bundleId: app.bundleId,
            name: app.name,
            applicationType: app.installType,
          })),
        };
      },
    },
  };
}

function normalizeDeviceInventory(stdout: string, session: Session): string {
  const inventory = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ udid: string }>>;
  };
  for (const devices of Object.values(inventory.devices ?? {})) {
    for (const device of devices) {
      if (device.udid === session.client.deviceInfo.udid) device.udid = session.device.id;
    }
  }
  return JSON.stringify(inventory);
}
