import {
  coerceExecResult,
  runCmd,
  whichCmd,
  type ExecOptions,
  type ExecResult,
} from '@agent-device/host-kit/command';
import type { ScopedSimctlArgs } from '@agent-device/contracts/platform-runtime-host';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import { createLocalAppleMacOsHostProvider } from '../os/macos/host-provider.ts';
import type {
  AppleMacOsHelperProvider,
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleSimctlToolProvider,
  AppleToolAvailabilityChecker,
  AppleToolCommandExecutor,
  AppleXcrunToolProvider,
} from './tool-provider-types.ts';

export type {
  AppleMacOsHelperProvider,
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleToolAvailabilityChecker,
  AppleToolCommandExecutor,
  AppleToolSubcommandExecutor,
  AppleXcrunToolProvider,
} from './tool-provider-types.ts';

declare const scopedSimctlCommand: unique symbol;
/** The xcrun argv of one simctl call: `simctl` followed by arguments already scoped to their set. */
export type ScopedSimctlCommand = readonly ['simctl', ...string[]] & {
  readonly [scopedSimctlCommand]: true;
};

export function simctlCommand(args: ScopedSimctlArgs): ScopedSimctlCommand {
  return Object.freeze(['simctl', ...args] as const) as ScopedSimctlCommand;
}

async function runSimctlCommand(
  runCommand: AppleToolCommandExecutor,
  args: ScopedSimctlArgs,
  options?: ExecOptions,
): Promise<ExecResult> {
  return await runCommand('xcrun', [...simctlCommand(args)], options);
}

function simctlCommandArgs(command: ScopedSimctlCommand): ScopedSimctlArgs {
  return Object.freeze(command.slice(1)) as ScopedSimctlArgs;
}

export type AppleToolProvider = {
  runCommand: AppleToolCommandExecutor;
  simctl: AppleSimctlToolProvider;
  devicectl: AppleXcrunToolProvider;
  macosHelper?: AppleMacOsHelperProvider;
  macosHost?: AppleMacOsHostProvider;
  plist?: ApplePlistProvider;
  whichCommand: AppleToolAvailabilityChecker;
};

const localAppleToolProvider: AppleToolProvider = {
  runCommand: runCmd,
  simctl: {
    run: async (args, options) => await runSimctlCommand(runCmd, args, options),
  },
  devicectl: {
    run: async (args, options) => await runCmd('xcrun', ['devicectl', ...args], options),
  },
  plist: {
    readJson: async (plistPath, signal) =>
      await readPlistJsonWithCommand(runCmd, plistPath, signal),
  },
  macosHost: createLocalAppleMacOsHostProvider(
    runCmd,
    async (plistPath) => await readPlistJsonWithCommand(runCmd, plistPath),
  ),
  whichCommand: whichCmd,
};

const appleToolProviderScope = createScopedProvider<AppleToolProvider>(
  localAppleToolProvider,
  normalizeAppleToolProvider,
);

export function createLocalAppleToolProvider(
  provider: Partial<AppleToolProvider> = {},
): AppleToolProvider {
  const merged = {
    ...localAppleToolProvider,
    ...provider,
  };
  const plist = provider.plist ?? {
    readJson: async (plistPath: string, signal?: AbortSignal) =>
      await readPlistJsonWithCommand(merged.runCommand, plistPath, signal),
  };
  return {
    ...merged,
    simctl: provider.simctl ?? {
      run: async (args, options) => await runSimctlCommand(merged.runCommand, args, options),
    },
    devicectl: provider.devicectl ?? {
      run: async (args, options) =>
        await merged.runCommand('xcrun', ['devicectl', ...args], options),
    },
    plist,
    macosHost:
      provider.macosHost ??
      createLocalAppleMacOsHostProvider(
        merged.runCommand,
        async (plistPath) => await plist.readJson(plistPath),
      ),
  };
}

export function resolveAppleToolProvider(provider?: AppleToolProvider): AppleToolProvider {
  return appleToolProviderScope.resolve(provider);
}

export async function withAppleToolProvider<T>(
  provider: AppleToolProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await appleToolProviderScope.run(provider, fn);
}

export function hasScopedAppleToolProvider(): boolean {
  return appleToolProviderScope.hasScope();
}

export async function runAppleToolCommand(
  cmd: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return await resolveAppleToolProvider().runCommand(cmd, args, options);
}

/**
 * Every Xcode tool agent-device runs through `xcrun`. `firstLaunchShim` marks a tool Xcode ships as a
 * script shim that can run `xcodebuild -runFirstLaunch` before the tool; the others are Mach-O binaries.
 */
export const XCRUN_TOOLS = {
  simctl: { firstLaunchShim: true },
  devicectl: { firstLaunchShim: true },
  xcdevice: { firstLaunchShim: false },
  xctrace: { firstLaunchShim: false },
} as const satisfies Record<string, { firstLaunchShim: boolean }>;

export type XcrunToolName = keyof typeof XCRUN_TOOLS;

/** An xcrun argv for a tool other than simctl; a simctl argv is a ScopedSimctlCommand. */
type XcrunToolArgs = readonly [Exclude<XcrunToolName, 'simctl'>, ...string[]];

export async function runXcrun(
  args: ScopedSimctlCommand | XcrunToolArgs,
  options?: ExecOptions,
): Promise<ExecResult> {
  const provider = resolveAppleToolProvider();
  if (args[0] === 'simctl') {
    return await provider.simctl.run(simctlCommandArgs(args), options);
  }
  const [tool, ...toolArgs] = args;
  if (tool === 'devicectl') {
    return await provider.devicectl.run(toolArgs, options);
  }
  return await runAppleToolCommand('xcrun', [...args], options);
}

export async function readApplePlistJson(
  plistPath: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return (await resolveAppleToolProvider().plist?.readJson(plistPath, signal)) ?? null;
}

function normalizeAppleToolProvider(provider: AppleToolProvider): AppleToolProvider {
  return createLocalAppleToolProvider({
    ...provider,
    runCommand: coerceRunCommand(provider.runCommand),
    simctl: { run: coerceRun(provider.simctl.run) },
    devicectl: { run: coerceRun(provider.devicectl.run) },
    ...(provider.macosHelper ? { macosHelper: { run: coerceRun(provider.macosHelper.run) } } : {}),
  });
}

// Scoped providers are SDK-supplied callbacks; coerce their results once at
// the boundary (see coerceExecResult) so platform code can trust the types.
function coerceRunCommand(run: AppleToolCommandExecutor): AppleToolCommandExecutor {
  return async (cmd, args, options) => coerceExecResult(await run(cmd, args, options));
}

function coerceRun<Args>(
  run: (args: Args, options?: ExecOptions) => Promise<ExecResult>,
): (args: Args, options?: ExecOptions) => Promise<ExecResult> {
  return async (args, options) => coerceExecResult(await run(args, options));
}

async function readPlistJsonWithCommand(
  runCommand: AppleToolCommandExecutor,
  plistPath: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      allowFailure: true,
      signal,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
