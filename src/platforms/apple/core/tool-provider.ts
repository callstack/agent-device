import { runCmd, whichCmd, type ExecOptions, type ExecResult } from '../../../utils/exec.ts';
import { createScopedProvider } from '../../../utils/scoped-provider.ts';
import { createLocalAppleMacOsHostProvider } from '../os/macos/host-provider.ts';
import type {
  AppleMacOsHelperProvider,
  AppleMacOsHostProvider,
  ApplePlistProvider,
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

export type AppleToolProvider = {
  runCommand: AppleToolCommandExecutor;
  simctl?: AppleXcrunToolProvider;
  devicectl?: AppleXcrunToolProvider;
  macosHelper?: AppleMacOsHelperProvider;
  macosHost?: AppleMacOsHostProvider;
  plist?: ApplePlistProvider;
  whichCommand: AppleToolAvailabilityChecker;
};

const localAppleToolProvider: AppleToolProvider = {
  runCommand: runCmd,
  simctl: {
    run: async (args, options) => await runCmd('xcrun', ['simctl', ...args], options),
  },
  devicectl: {
    run: async (args, options) => await runCmd('xcrun', ['devicectl', ...args], options),
  },
  plist: {
    readJson: async (plistPath) => await readPlistJsonWithCommand(runCmd, plistPath),
  },
  macosHost: createLocalAppleMacOsHostProvider(
    runCmd,
    async (plistPath) => await readPlistJsonWithCommand(runCmd, plistPath),
  ),
  whichCommand: whichCmd,
};

type AppleToolProviderInput = AppleToolProvider | AppleToolCommandExecutor;

const appleToolProviderScope = createScopedProvider<AppleToolProvider, AppleToolProviderInput>(
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
    readJson: async (plistPath: string) =>
      await readPlistJsonWithCommand(merged.runCommand, plistPath),
  };
  return {
    ...merged,
    simctl: provider.simctl ?? {
      run: async (args, options) => await merged.runCommand('xcrun', ['simctl', ...args], options),
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

export function resolveAppleToolProvider(provider?: AppleToolProviderInput): AppleToolProvider {
  return appleToolProviderScope.resolve(provider);
}

export async function withAppleToolProvider<T>(
  provider: AppleToolProviderInput | undefined,
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

export async function runXcrun(args: string[], options?: ExecOptions): Promise<ExecResult> {
  const provider = resolveAppleToolProvider();
  const [tool, ...toolArgs] = args;
  if (tool === 'simctl') {
    return await (provider.simctl?.run(toolArgs, options) ??
      provider.runCommand('xcrun', args, options));
  }
  if (tool === 'devicectl') {
    return await (provider.devicectl?.run(toolArgs, options) ??
      provider.runCommand('xcrun', args, options));
  }
  return await runAppleToolCommand('xcrun', args, options);
}

export async function readApplePlistJson(
  plistPath: string,
): Promise<Record<string, unknown> | null> {
  return (await resolveAppleToolProvider().plist?.readJson(plistPath)) ?? null;
}

function normalizeAppleToolProvider(provider: AppleToolProviderInput): AppleToolProvider {
  if (typeof provider === 'function') {
    return createLocalAppleToolProvider({ runCommand: provider });
  }
  return createLocalAppleToolProvider(provider);
}

async function readPlistJsonWithCommand(
  runCommand: AppleToolCommandExecutor,
  plistPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      allowFailure: true,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}
