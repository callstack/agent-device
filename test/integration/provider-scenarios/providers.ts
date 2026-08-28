import type { AppleRunnerScreenRecordingTransport } from '../../../src/platform-runtime-screen-recording-apple-runner-transport.ts';
import type { AppleRunnerProvider, RunnerCommand } from '@agent-device/platform-apple/runner';
import type {
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleToolProvider,
  AppleToolSubcommandExecutor,
} from '@agent-device/platform-apple/tool-provider';
import { type ExecResult } from '@agent-device/host-kit/command';
import type { ProviderScenarioTranscript } from './transcript.ts';

export type FlatToolCall = [string, ...string[]];

type RecordingAppleToolHandlers = {
  simctl?: AppleToolSubcommandExecutor;
  devicectl?: AppleToolSubcommandExecutor;
  macosHelper?: AppleToolSubcommandExecutor;
  macosHost?: AppleMacOsHostProvider;
  plist?: ApplePlistProvider;
};

export function createAppleRunnerProviderFromTranscript(
  transcript: ProviderScenarioTranscript,
  commandPrefix: 'ios.runner' | 'macos.runner' | 'tvos.runner',
): AppleRunnerProvider {
  return {
    runCommand: async (device, command) =>
      transcript.next(`${commandPrefix}.${command.command}`, stripRunnerCommandId(command), {
        deviceId: device.id,
        platform: device.platform,
      }) as Record<string, unknown>,
  };
}

export function createAppleRunnerScreenRecordingTransportFromTranscript(
  transcript: ProviderScenarioTranscript,
  commandPrefix: 'ios.runner' | 'macos.runner',
  onStopped?: (outputPath: string) => void,
): AppleRunnerScreenRecordingTransport {
  const active = new Map<
    string,
    Readonly<{ deviceId: string; appBundleId: string; outputPath: string }>
  >();
  const knownSessions = new Map<string, string>();
  return Object.freeze({
    authority: 'scoped-provider',
    available: true,
    start: async ({ device, appBundleId, outputPath, fps }) => {
      const result = transcript.next(
        `${commandPrefix}.recordStart`,
        {
          command: 'recordStart',
          outPath: outputPath,
          ...(fps === undefined ? {} : { fps }),
          appBundleId,
        },
        { deviceId: device.id, platform: device.platform },
      ) as Readonly<{ runnerSessionId?: unknown }>;
      if (typeof result.runnerSessionId !== 'string' || result.runnerSessionId.length === 0) {
        throw new Error('scripted runner recording did not return an exact session identity');
      }
      active.set(result.runnerSessionId, { deviceId: device.id, appBundleId, outputPath });
      knownSessions.set(result.runnerSessionId, device.id);
      return Object.freeze({ runnerSessionId: result.runnerSessionId });
    },
    inspect: async (device, runnerSessionId) => {
      const recording = active.get(runnerSessionId);
      if (recording?.deviceId === device.id) return 'owned-alive';
      return knownSessions.get(runnerSessionId) === device.id ? 'missing' : 'ownership-lost';
    },
    stop: async ({ device, runnerSessionId, appBundleId }) => {
      const recording = active.get(runnerSessionId);
      if (
        recording?.deviceId !== device.id ||
        (appBundleId !== undefined && recording.appBundleId !== appBundleId)
      ) {
        throw new Error('scripted runner recording ownership changed before stop');
      }
      transcript.next(
        `${commandPrefix}.recordStop`,
        { command: 'recordStop', appBundleId },
        { deviceId: device.id, platform: device.platform },
      );
      onStopped?.(recording.outputPath);
      active.delete(runnerSessionId);
    },
  });
}

function stripRunnerCommandId(command: RunnerCommand): RunnerCommand {
  if (command.commandId === undefined) return command;
  const normalized = { ...command };
  delete normalized.commandId;
  return normalized;
}

export function createRecordingAppleToolProvider(handlers: RecordingAppleToolHandlers = {}): {
  provider: AppleToolProvider;
  calls: FlatToolCall[];
} {
  const calls: FlatToolCall[] = [];
  const plistHandler = handlers.plist;
  const missingHandler = async (label: string): Promise<ExecResult> => {
    throw new Error(`Unscripted Apple Provider-backed integration provider call: ${label}`);
  };
  return {
    calls,
    provider: {
      whichCommand: async () => true,
      runCommand: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (isSimulatorHostOpenCommand(cmd, args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return await missingHandler([cmd, ...args].join(' '));
      },
      simctl: {
        run: async (args, options) => {
          calls.push(['simctl', ...args]);
          return handlers.simctl
            ? await handlers.simctl(args, options)
            : await missingHandler(['simctl', ...args].join(' '));
        },
      },
      devicectl: {
        run: async (args, options) => {
          calls.push(['devicectl', ...args]);
          return handlers.devicectl
            ? await handlers.devicectl(args, options)
            : await missingHandler(['devicectl', ...args].join(' '));
        },
      },
      macosHelper: {
        run: async (args, options) => {
          calls.push(['macos-helper', ...args]);
          return handlers.macosHelper
            ? await handlers.macosHelper(args, options)
            : await missingHandler(['macos-helper', ...args].join(' '));
        },
      },
      macosHost: createRecordingMacOsHostProvider(calls, handlers.macosHost),
      plist: plistHandler
        ? {
            readJson: async (plistPath) => {
              calls.push(['plist', 'readJson', plistPath]);
              return await plistHandler.readJson(plistPath);
            },
          }
        : undefined,
    },
  };
}

const SIMULATOR_HOST_OPEN_COMMANDS = new Set([
  '-a Device Hub',
  '-a Simulator',
  '-g -a Device Hub',
  '-g -a Simulator',
]);

function isSimulatorHostOpenCommand(cmd: string, args: string[]): boolean {
  return cmd === 'open' && SIMULATOR_HOST_OPEN_COMMANDS.has(args.join(' '));
}

function createRecordingMacOsHostProvider(
  calls: FlatToolCall[],
  host: AppleMacOsHostProvider | undefined,
): AppleMacOsHostProvider {
  return {
    openBundle: async (bundleId, url) => {
      calls.push(['macos-host', 'openBundle', bundleId, ...(url ? [url] : [])]);
      await host?.openBundle?.(bundleId, url);
    },
    openTarget: async (target) => {
      calls.push(['macos-host', 'openTarget', target]);
      await host?.openTarget?.(target);
    },
    readClipboard: async () => {
      calls.push(['macos-host', 'readClipboard']);
      return (await host?.readClipboard?.()) ?? '';
    },
    writeClipboard: async (text) => {
      calls.push(['macos-host', 'writeClipboard', text]);
      await host?.writeClipboard?.(text);
    },
    readDarkMode: async () => {
      calls.push(['macos-host', 'readDarkMode']);
      return (await host?.readDarkMode?.()) ?? false;
    },
    setDarkMode: async (enabled) => {
      calls.push(['macos-host', 'setDarkMode', String(enabled)]);
      await host?.setDarkMode?.(enabled);
    },
    listApps: async (filter) => {
      calls.push(['macos-host', 'listApps', filter]);
      return (await host?.listApps?.(filter)) ?? [];
    },
  };
}

function simctlListDevicesJson(
  runtime: string,
  devices: Array<{ name: string; udid: string; state?: string; isAvailable?: boolean }>,
): ExecResult {
  return {
    stdout: `${JSON.stringify({
      devices: {
        [runtime]: devices.map((device) => ({
          state: 'Booted',
          isAvailable: true,
          ...device,
        })),
      },
    })}\n`,
    stderr: '',
    exitCode: 0,
  };
}

export function simctlDeviceLifecycleHandler(
  runtime: string,
  devices: Array<{ name: string; udid: string; state?: string; isAvailable?: boolean }>,
): AppleToolSubcommandExecutor {
  return async (args) => {
    const result = simctlListDevicesResult(args, runtime, devices);
    if (result) return result;
    if (isModeledSimulatorLifecycleCommand(args)) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return unexpectedProviderCall('Apple', ['simctl', ...args]);
  };
}

function isModeledSimulatorLifecycleCommand(args: readonly string[]): boolean {
  if (args[0] === 'boot' || args[0] === 'shutdown') return args.length === 2;
  if (args[0] === 'launch' || args[0] === 'terminate') return args.length === 3;
  return false;
}

export function unexpectedProviderCall(platform: string, command: readonly string[]): never {
  throw new Error(`Unscripted ${platform} provider call: ${command.join(' ')}`);
}

export function simctlListDevicesResult(
  args: string[],
  runtime: string,
  devices: Array<{ name: string; udid: string; state?: string; isAvailable?: boolean }>,
): ExecResult | undefined {
  if (args.join(' ') !== 'list devices -j') {
    return undefined;
  }
  return simctlListDevicesJson(runtime, devices);
}
