import { readHostTextFile } from '@agent-device/host-kit/host-file';
import {
  readApplePlistJson,
  runAppleToolCommand,
  XCRUN_TOOL_NAMES,
  type XcrunToolName,
} from './tool-provider.ts';

const XCRUN_SHIM_PROBE_BUDGET_MS = 2_000;
const FIRST_LAUNCH_FLAG = '-runFirstLaunch';

/**
 * Whether one Xcode `xcrun` shim runs `xcodebuild -runFirstLaunch` before the tool it wraps. That
 * cleanup deletes every device in `~/Library/Developer/XCTestDevices`. The shim compares its own
 * `EXPECTED_VERSION` with the installed framework's `CFBundleVersion`; a shim whose versions could
 * not be read is `armed`.
 */
export type XcrunShimFirstLaunchHook =
  | { tool: XcrunToolName; shimPath: string; hook: 'none' }
  | {
      tool: XcrunToolName;
      shimPath: string;
      hook: 'disarmed';
      expectedVersion: string;
      frameworkInfoPlistPath: string;
      installedVersion: string;
    }
  | ArmedXcrunShimFirstLaunchHook;

export type ArmedXcrunShimFirstLaunchHook = {
  tool: XcrunToolName;
  /** Null when `xcrun --find` failed or ran out of budget. */
  shimPath: string | null;
  hook: 'armed';
  expectedVersion: string | null;
  frameworkInfoPlistPath: string | null;
  installedVersion: string | null;
};

/** One entry per {@link XCRUN_TOOL_NAMES} tool. */
export type XctestDeviceSetCleanupArming = readonly XcrunShimFirstLaunchHook[];

export type XcrunShimProbeOptions = {
  /** Replaces `xcrun --find`: a tool absent from the map reads as not found. */
  xcrunShimPaths?: Readonly<Partial<Record<XcrunToolName, string>>>;
};

/** Reads every xcrun shim's first-launch hook within one shared budget; a timeout reads as armed. */
export async function probeXcrunShimFirstLaunchHooks(
  options: XcrunShimProbeOptions = {},
): Promise<XctestDeviceSetCleanupArming> {
  const signal = AbortSignal.timeout(XCRUN_SHIM_PROBE_BUDGET_MS);
  return await Promise.all(
    XCRUN_TOOL_NAMES.map(async (tool) => await probeWithinBudget(tool, options, signal)),
  );
}

async function probeWithinBudget(
  tool: XcrunToolName,
  options: XcrunShimProbeOptions,
  signal: AbortSignal,
): Promise<XcrunShimFirstLaunchHook> {
  const evidence: ArmedXcrunShimFirstLaunchHook = {
    tool,
    shimPath: null,
    hook: 'armed',
    expectedVersion: null,
    frameworkInfoPlistPath: null,
    installedVersion: null,
  };
  let onAbort = (): void => {};
  const expired = new Promise<XcrunShimFirstLaunchHook>((resolve) => {
    onAbort = () => resolve({ ...evidence });
  });
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([readShimHook(evidence, options, signal), expired]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readShimHook(
  evidence: ArmedXcrunShimFirstLaunchHook,
  options: XcrunShimProbeOptions,
  signal: AbortSignal,
): Promise<XcrunShimFirstLaunchHook> {
  const { tool } = evidence;
  const shimPath = await locateShim(tool, options, signal);
  if (shimPath === null) return { ...evidence };
  evidence.shimPath = shimPath;
  const text = await readShimText(shimPath, signal);
  if (text === null) return { ...evidence };
  if (!text.startsWith('#!') || !text.includes(FIRST_LAUNCH_FLAG)) {
    return { tool, shimPath, hook: 'none' };
  }
  await readShimVersions(evidence, text, signal);
  return settleShimHook(evidence, shimPath);
}

async function readShimVersions(
  evidence: ArmedXcrunShimFirstLaunchHook,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  evidence.expectedVersion = /^\s*EXPECTED_VERSION="([^"]+)"/m.exec(text)?.[1] ?? null;
  evidence.frameworkInfoPlistPath = parseFrameworkInfoPlistPath(text);
  if (evidence.frameworkInfoPlistPath !== null) {
    evidence.installedVersion = await readBundleVersion(evidence.frameworkInfoPlistPath, signal);
  }
}

function settleShimHook(
  evidence: ArmedXcrunShimFirstLaunchHook,
  shimPath: string,
): XcrunShimFirstLaunchHook {
  const { tool, expectedVersion, frameworkInfoPlistPath, installedVersion } = evidence;
  if (expectedVersion === null || frameworkInfoPlistPath === null || installedVersion === null) {
    return { ...evidence };
  }
  if (expectedVersion !== installedVersion) return { ...evidence };
  return {
    tool,
    shimPath,
    hook: 'disarmed',
    expectedVersion,
    frameworkInfoPlistPath,
    installedVersion,
  };
}

async function locateShim(
  tool: XcrunToolName,
  options: XcrunShimProbeOptions,
  signal: AbortSignal,
): Promise<string | null> {
  if (options.xcrunShimPaths) return options.xcrunShimPaths[tool] ?? null;
  try {
    const result = await runAppleToolCommand('xcrun', ['--find', tool], {
      allowFailure: true,
      timeoutMs: XCRUN_SHIM_PROBE_BUDGET_MS,
      signal,
    });
    const found = result.stdout.trim();
    return result.exitCode === 0 && found ? found : null;
  } catch {
    return null;
  }
}

async function readShimText(shimPath: string, signal: AbortSignal): Promise<string | null> {
  try {
    return await readHostTextFile(shimPath, { signal });
  } catch {
    return null;
  }
}

function parseFrameworkInfoPlistPath(text: string): string | null {
  const currentVersionLine = /^\s*CURRENT_VERSION=.*$/m.exec(text)?.[0];
  if (currentVersionLine === undefined) return null;
  return /"([^"]*Info\.plist)"/.exec(currentVersionLine)?.[1] ?? null;
}

async function readBundleVersion(plistPath: string, signal: AbortSignal): Promise<string | null> {
  try {
    const plist = await readApplePlistJson(plistPath, signal);
    const version = plist?.CFBundleVersion;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}
