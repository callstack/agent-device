import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  coerceExecResult,
  requireExecSuccess,
  runCmd,
  whichCmd,
  type ExecOptions,
  type ExecResult,
  commandHostEnvironment,
} from '@agent-device/host-kit/command';
import type {
  ScopedSimctlArgs,
  ScopedSimctlCommand,
} from '@agent-device/contracts/platform-runtime-host';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import { createLocalAppleMacOsHostProvider } from '../os/macos/host-provider.ts';
import type {
  AppleMacOsHelperProvider,
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleSimctlToolProvider,
  AppleSimulatorFileCopy,
  AppleSimulatorContainerRequest,
  AppleSimulatorContainer,
  AppleSimulatorAppInfoRequest,
  SimulatorAppListOptions,
  SimulatorAppListRead,
  AppleToolAvailabilityChecker,
  AppleToolCommandExecutor,
  AppleToolExecOptions,
  AppleXcrunToolProvider,
} from './tool-provider-types.ts';

export type {
  AppleMacOsHelperProvider,
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleToolAvailabilityChecker,
  AppleToolCommandExecutor,
  AppleToolExecOptions,
  AppleToolSubcommandExecutor,
  AppleXcrunToolProvider,
} from './tool-provider-types.ts';

export type { ScopedSimctlCommand };

export function simctlCommand(args: ScopedSimctlArgs): ScopedSimctlCommand {
  return Object.freeze(['simctl', ...args] as const) as ScopedSimctlCommand;
}

async function runSimctlCommand(
  runCommand: AppleToolCommandExecutor,
  args: ScopedSimctlArgs,
  options?: AppleToolExecOptions,
): Promise<ExecResult> {
  return await runCommand('xcrun', [...simctlCommand(args)], options);
}

/**
 * simctl's own error-protocol header, printed once at the top of stderr ahead of the human
 * sentence it renders: `An error was encountered processing the command (domain=…, code=…):`.
 * The header line is the protocol; the text after it is CoreSimulator's prose. A nested
 * `Underlying error (…)` line is indented and is never this line.
 */
const SIMCTL_ERROR_HEADER =
  /^An error was encountered processing the command \(domain=([^,]+), code=(-?\d+)\):\s*$/m;

/**
 * `NSPOSIXErrorDomain` code 60 is macOS `ETIMEDOUT`: the tool's own answer that the screenshot
 * call timed out. This is the only place that reads it, so the verdict becomes a typed reason here
 * and nothing downstream re-parses the tool's text. A nested `Underlying error (…)` line is
 * indented and is never the header, and a code the header does not state is not this reason.
 */
const SIMCTL_SCREENSHOT_TIMEOUT_DOMAIN = 'NSPOSIXErrorDomain';
const SIMCTL_SCREENSHOT_TIMEOUT_CODE = 60;

/**
 * `details.reason` this adapter stamps when simctl's screenshot call reports its own protocol
 * timeout. Owned beside the parse that mints it; the screenshot retry and runner-fallback decisions
 * read the reason and never the tool's wording.
 */
export const SIMCTL_SCREENSHOT_TIMEOUT_REASON = 'simulator-screenshot-timeout';

/**
 * The screenshot subcommand of an otherwise-unscoped simctl argv: `io <udid> screenshot …`. The
 * `--set <path>` prefix is stripped first, and the flag fragments simctl's screenshot options add
 * (`--mask=`, `--display=`) come after the subcommand, so positions 0 and 2 are the verb pair.
 */
function isSimctlScreenshotArgs(args: ScopedSimctlArgs): boolean {
  const unscoped = args[0] === '--set' ? args.slice(2) : args;
  return unscoped[0] === 'io' && unscoped[2] === 'screenshot';
}

/**
 * The local simctl adapter: the one producer that runs `xcrun simctl` itself, so the one place
 * allowed to read the tool's error protocol. A failed screenshot call answers with the typed
 * {@link SIMCTL_SCREENSHOT_TIMEOUT_CODE} reason and keeps every exit-failure detail the exec layer
 * would have produced; other failures, and other subcommands, keep exec's own behaviour.
 *
 * `reason` is stamped, never host-kit's `timeoutMs`: that field is exec's evidence that *it* killed
 * a child at its deadline, and `isCommandTimeoutError` reads it as such.
 */
async function runLocalSimctlCommand(
  args: ScopedSimctlArgs,
  options?: AppleToolExecOptions,
): Promise<ExecResult> {
  const commandArgs = [...simctlCommand(args)];
  if (options?.allowFailure || !isSimctlScreenshotArgs(args)) {
    return await runCmd('xcrun', commandArgs, options);
  }
  const result = await runCmd('xcrun', commandArgs, { ...options, allowFailure: true });
  const header = SIMCTL_ERROR_HEADER.exec(result.stderr);
  const isScreenshotTimeout =
    header?.[1] === SIMCTL_SCREENSHOT_TIMEOUT_DOMAIN &&
    Number(header?.[2]) === SIMCTL_SCREENSHOT_TIMEOUT_CODE;
  return requireExecSuccess(result, `xcrun exited with code ${result.exitCode}`, {
    cmd: 'xcrun',
    args: commandArgs,
    ...(isScreenshotTimeout ? { reason: SIMCTL_SCREENSHOT_TIMEOUT_REASON } : {}),
  });
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
  /** Hosts without a simctl screenshot transport use the runner's file capture. */
  simulatorScreenshotBackend?: 'runner';
  simulatorFiles: {
    copyToHost(request: AppleSimulatorFileCopy): Promise<void>;
    openContainer(request: AppleSimulatorContainerRequest): Promise<AppleSimulatorContainer | null>;
    stageFile(path: string, signal?: AbortSignal): Promise<AsyncDisposable & { path: string }>;
  };
  simulatorApps: {
    list(device: DeviceInfo, options?: SimulatorAppListOptions): Promise<SimulatorAppListRead>;
    readInfoPlist(request: AppleSimulatorAppInfoRequest): Promise<Record<string, unknown> | null>;
  };
  whichCommand: AppleToolAvailabilityChecker;
};

export const APPLE_PLIST_TIMEOUT_MS = 15_000;

const localAppleToolProvider = createLocalAppleToolProvider();

const appleToolProviderScope = createScopedProvider<AppleToolProvider>(
  localAppleToolProvider,
  createLocalAppleToolProvider,
);

export function createLocalAppleToolProvider(
  provider: Partial<AppleToolProvider> = {},
): AppleToolProvider {
  const runCommand = coerceRunCommand(provider.runCommand ?? runCmd);
  const simctl: AppleSimctlToolProvider = {
    run: provider.simctl
      ? coerceRun(provider.simctl.run)
      : provider.runCommand
        ? async (args, options) => await runSimctlCommand(runCommand, args, options)
        : runLocalSimctlCommand,
  };
  const plist = provider.plist ?? {
    readJson: async (plistPath: string, signal?: AbortSignal) =>
      await readPlistJsonWithCommand(runCommand, plistPath, signal),
  };
  const tools = { simctl, runCommand };
  return {
    ...provider,
    simctl,
    runCommand,
    ...(provider.macosHelper ? { macosHelper: { run: coerceRun(provider.macosHelper.run) } } : {}),
    simulatorFiles: provider.simulatorFiles ?? {
      copyToHost: async (request) =>
        await (await import('./local-simulator-files.ts')).copySimulatorFileToHost(simctl, request),
      openContainer: async (request) =>
        await (await import('./local-simulator-files.ts')).openSimulatorContainer(simctl, request),
      stageFile: async (path, signal) => {
        signal?.throwIfAborted();
        return { path, [Symbol.asyncDispose]: async () => {} };
      },
    },
    simulatorApps: provider.simulatorApps ?? {
      list: async (device, options) =>
        await (
          await import('./local-simulator-apps.ts')
        ).readSimulatorAppMetadata(tools, device, options),
      readInfoPlist: async (request) =>
        await (await import('./local-simulator-apps.ts')).readSimulatorAppInfoPlist(tools, request),
    },
    devicectl: {
      run: provider.devicectl
        ? coerceRun(provider.devicectl.run)
        : async (args, options) => await runCommand('xcrun', ['devicectl', ...args], options),
    },
    plist,
    macosHost:
      provider.macosHost ??
      createLocalAppleMacOsHostProvider(
        runCommand,
        async (plistPath) => await plist.readJson(plistPath),
      ),
    whichCommand:
      provider.whichCommand ?? (async (cmd) => await whichCmd(cmd, commandHostEnvironment().env)),
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

/** An xcrun argv for a tool other than simctl; a simctl argv is a ScopedSimctlCommand. */
type XcrunToolArgs = readonly ['devicectl' | 'xcdevice' | 'xctrace', ...string[]];

export async function runXcrun(
  args: ScopedSimctlCommand | XcrunToolArgs,
  options?: AppleToolExecOptions,
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
      timeoutMs: APPLE_PLIST_TIMEOUT_MS,
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
