import type { AppleRunnerProvider } from '../../../src/platforms/apple/core/runner/runner-provider.ts';
import type { RunnerCommand } from '../../../src/platforms/apple/core/runner/runner-contract.ts';
import type {
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleToolProvider,
  AppleToolSubcommandExecutor,
} from '../../../src/platforms/apple/core/tool-provider.ts';
import type { ExecResult } from '../../../src/utils/exec.ts';
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

export function simctlListDevicesHandler(
  runtime: string,
  devices: Array<{ name: string; udid: string; state?: string; isAvailable?: boolean }>,
): AppleToolSubcommandExecutor {
  return async (args) => {
    return (
      simctlListDevicesResult(args, runtime, devices) ?? { stdout: '', stderr: '', exitCode: 0 }
    );
  };
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
