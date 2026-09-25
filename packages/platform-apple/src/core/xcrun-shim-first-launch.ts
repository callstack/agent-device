import { readHostTextFile } from '@agent-device/host-kit/host-file';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import {
  readApplePlistJson,
  runAppleToolCommand,
  XCRUN_TOOLS,
  type XcrunToolName,
} from './tool-provider.ts';

const FIRST_LAUNCH_FLAG = '-runFirstLaunch';

export type XcrunShimToolName = {
  [Tool in XcrunToolName]: (typeof XCRUN_TOOLS)[Tool]['firstLaunchShim'] extends true
    ? Tool
    : never;
}[XcrunToolName];

/** The {@link XCRUN_TOOLS} entries Xcode ships as a shim that can carry a first-launch hook. */
export const XCRUN_SHIM_TOOL_NAMES = (Object.keys(XCRUN_TOOLS) as XcrunToolName[]).filter(
  (tool): tool is XcrunShimToolName => XCRUN_TOOLS[tool].firstLaunchShim,
);

/**
 * Whether one Xcode `xcrun` shim runs `xcodebuild -runFirstLaunch` before the tool it wraps. That
 * cleanup deletes every device in `~/Library/Developer/XCTestDevices`. The shim compares its own
 * `EXPECTED_VERSION` with the installed framework's `CFBundleVersion`; a shim whose versions could
 * not be read is `armed`.
 */
export type XcrunShimFirstLaunchHook =
  | { tool: XcrunShimToolName; shimPath: string; hook: 'none' }
  | {
      tool: XcrunShimToolName;
      shimPath: string;
      hook: 'disarmed';
      expectedVersion: string;
      frameworkInfoPlistPath: string;
      installedVersion: string;
    }
  | ArmedXcrunShimFirstLaunchHook;

/** Why a shim reads as armed; every value but `version_mismatch` is a probe that could not decide. */
export type XcrunShimArmedBy =
  | 'version_mismatch'
  | 'version_unreadable'
  | 'shim_unreadable'
  | 'shim_not_located'
  | 'probe_out_of_budget'
  | 'probe_canceled';

type XcrunShimEvidence = {
  tool: XcrunShimToolName;
  /** Null when `xcrun --find` failed or the probe stopped first. */
  shimPath: string | null;
  expectedVersion: string | null;
  frameworkInfoPlistPath: string | null;
  installedVersion: string | null;
};

export type ArmedXcrunShimFirstLaunchHook = XcrunShimEvidence & {
  hook: 'armed';
  armedBy: XcrunShimArmedBy;
};

/** One entry per {@link XCRUN_SHIM_TOOL_NAMES} tool. */
export type XctestDeviceSetCleanupArming = readonly XcrunShimFirstLaunchHook[];

export type XcrunShimProbeOptions = {
  /** The owning request's cancellation; an unanswered shim then reads as `probe_canceled`. */
  signal?: AbortSignal;
};

/** Reads every shim's first-launch hook within one shared budget; an unanswered shim reads as armed. */
export async function probeXcrunShimFirstLaunchHooks(
  options: XcrunShimProbeOptions = {},
): Promise<XctestDeviceSetCleanupArming> {
  const budget = AbortSignal.timeout(COLD_TOOLCHAIN_PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([budget, options.signal]) : budget;
  const stoppedBy = (): XcrunShimArmedBy =>
    options.signal?.aborted ? 'probe_canceled' : 'probe_out_of_budget';
  return await Promise.all(
    XCRUN_SHIM_TOOL_NAMES.map(async (tool) => await probeWithinBudget(tool, signal, stoppedBy)),
  );
}

async function probeWithinBudget(
  tool: XcrunShimToolName,
  signal: AbortSignal,
  stoppedBy: () => XcrunShimArmedBy,
): Promise<XcrunShimFirstLaunchHook> {
  const evidence: XcrunShimEvidence = {
    tool,
    shimPath: null,
    expectedVersion: null,
    frameworkInfoPlistPath: null,
    installedVersion: null,
  };
  if (signal.aborted) return armed(evidence, stoppedBy());
  let onAbort = (): void => {};
  const stopped = new Promise<XcrunShimFirstLaunchHook>((resolve) => {
    onAbort = () => resolve(armed(evidence, stoppedBy()));
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([readShimHook(evidence, signal), stopped]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function armed(
  evidence: XcrunShimEvidence,
  armedBy: XcrunShimArmedBy,
): ArmedXcrunShimFirstLaunchHook {
  return { ...evidence, hook: 'armed', armedBy };
}

async function readShimHook(
  evidence: XcrunShimEvidence,
  signal: AbortSignal,
): Promise<XcrunShimFirstLaunchHook> {
  const { tool } = evidence;
  const shimPath = await locateShim(tool, signal);
  if (shimPath === null) return armed(evidence, 'shim_not_located');
  evidence.shimPath = shimPath;
  const text = await readShimText(shimPath, signal);
  if (text === null) return armed(evidence, 'shim_unreadable');
  if (!text.startsWith('#!') || !text.includes(FIRST_LAUNCH_FLAG)) {
    return { tool, shimPath, hook: 'none' };
  }
  await readShimVersions(evidence, text, signal);
  return settleShimHook(evidence, shimPath);
}

async function readShimVersions(
  evidence: XcrunShimEvidence,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  evidence.expectedVersion = /^\s*EXPECTED_VERSION="([^"]+)"/m.exec(text)?.[1] ?? null;
  evidence.frameworkInfoPlistPath = parseFrameworkInfoPlistPath(text);
  if (evidence.frameworkInfoPlistPath !== null) {
    evidence.installedVersion = await readBundleVersion(evidence.frameworkInfoPlistPath, signal);
  }
}

function settleShimHook(evidence: XcrunShimEvidence, shimPath: string): XcrunShimFirstLaunchHook {
  const { tool, expectedVersion, frameworkInfoPlistPath, installedVersion } = evidence;
  if (expectedVersion === null || frameworkInfoPlistPath === null || installedVersion === null) {
    return armed(evidence, 'version_unreadable');
  }
  if (expectedVersion !== installedVersion) return armed(evidence, 'version_mismatch');
  return {
    tool,
    shimPath,
    hook: 'disarmed',
    expectedVersion,
    frameworkInfoPlistPath,
    installedVersion,
  };
}

async function locateShim(tool: XcrunShimToolName, signal: AbortSignal): Promise<string | null> {
  try {
    const result = await runAppleToolCommand('xcrun', ['--find', tool], {
      allowFailure: true,
      timeoutMs: COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
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
