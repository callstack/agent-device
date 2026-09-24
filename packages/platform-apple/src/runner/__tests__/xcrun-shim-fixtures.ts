import fs from 'node:fs';
import path from 'node:path';
import type { ExecResult } from '@agent-device/host-kit/command';
import {
  createLocalAppleToolProvider,
  withAppleToolProvider,
  XCRUN_TOOL_NAMES,
  type XcrunToolName,
} from '../../core/tool-provider.ts';
import { appleRunnerTestHost } from '../test-host.ts';

/**
 * Fake Xcode `xcrun` shims for the XCTest device-set redirect's first-launch gate (#2935). The
 * hooked shape follows Xcode 26.2's `simctl` and `devicectl` shims: an `EXPECTED_VERSION` line, a
 * `CURRENT_VERSION` line that names the framework's Info.plist, and `xcodebuild -runFirstLaunch`
 * when the two differ. Installed versions are answered by a fake plist reader, so no test runs
 * `xcrun`, `plutil`, or reads the host's Xcode.
 */
export type FakeXcrunShim =
  | { expectedVersion: string; installedVersion: string }
  | { hook: 'none' }
  | { text: string };

export type FakeXcrunHost = {
  xcrunShimPaths: Partial<Record<XcrunToolName, string>>;
  /** `CFBundleVersion` by Info.plist path; a path left out reads as an unreadable plist. */
  installedVersions: Map<string, string>;
  /** Every Info.plist path the probe asked for, in call order. */
  plistReads: string[];
};

export function hookedShimText(expectedVersion: string, infoPlistPath: string): string {
  return [
    '#!/bin/bash',
    `EXPECTED_VERSION="${expectedVersion}"`,
    `CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "${infoPlistPath}" 2>&1)"`,
    '',
    'if [[ "${EXPECTED_VERSION}" != "${CURRENT_VERSION}" ]]; then',
    '    "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
    'fi',
    '',
  ].join('\n');
}

const HOOKLESS_SHIM_TEXT = '#!/bin/bash\nexec "${DEVELOPER_DIR}/usr/bin/tool" "${@}"\n';

const FAKE_FRAMEWORK_NAMES: Record<XcrunToolName, string> = {
  simctl: 'CoreSimulator',
  devicectl: 'CoreDevice',
  xcdevice: 'XCDevice',
  xctrace: 'XCTrace',
};

/** Where a fake tool's framework Info.plist lives under `root`. */
export function fakeFrameworkInfoPlistPath(root: string, tool: XcrunToolName): string {
  return path.join(root, `${FAKE_FRAMEWORK_NAMES[tool]}.framework`, 'Info.plist');
}

/** Writes one shim file per listed tool; a tool left out is absent from `xcrunShimPaths`. */
export function writeFakeXcrunShims(
  root: string,
  shims: Readonly<Partial<Record<XcrunToolName, FakeXcrunShim>>>,
): FakeXcrunHost {
  const shimDir = path.join(root, 'xcrun-shims');
  fs.mkdirSync(shimDir, { recursive: true });
  const xcrunShimPaths: Partial<Record<XcrunToolName, string>> = {};
  const installedVersions = new Map<string, string>();
  for (const tool of XCRUN_TOOL_NAMES) {
    const shim = shims[tool];
    if (!shim) continue;
    const plistPath = fakeFrameworkInfoPlistPath(root, tool);
    let text = HOOKLESS_SHIM_TEXT;
    if ('expectedVersion' in shim) {
      text = hookedShimText(shim.expectedVersion, plistPath);
      installedVersions.set(plistPath, shim.installedVersion);
    } else if ('text' in shim) {
      text = shim.text;
    }
    const shimPath = path.join(shimDir, tool);
    fs.writeFileSync(shimPath, text);
    xcrunShimPaths[tool] = shimPath;
  }
  return { xcrunShimPaths, installedVersions, plistReads: [] };
}

/** Every declared tool present and without a first-launch hook. */
export function writeHooklessXcrunShims(root: string): FakeXcrunHost {
  return writeFakeXcrunShims(
    root,
    Object.fromEntries(XCRUN_TOOL_NAMES.map((tool) => [tool, { hook: 'none' }])),
  );
}

/**
 * Runs `task` with `xcrun --find` answered from `host.xcrunShimPaths` and every Info.plist read
 * answered from the fake shims' installed versions, recorded in `host.plistReads`.
 */
export async function withFakeXcrunHost<T>(
  host: FakeXcrunHost,
  task: () => Promise<T>,
): Promise<T> {
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args): Promise<ExecResult> => {
      const found =
        cmd === 'xcrun' && args[0] === '--find'
          ? host.xcrunShimPaths[args[1] as XcrunToolName]
          : undefined;
      return found
        ? { exitCode: 0, stdout: `${found}\n`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: `fake xcrun host does not answer ${cmd}` };
    },
    plist: {
      readJson: async (plistPath) => {
        host.plistReads.push(plistPath);
        const version = host.installedVersions.get(plistPath);
        return version === undefined ? null : { CFBundleVersion: version };
      },
    },
  });
  return await withAppleToolProvider(provider, task);
}

/**
 * Makes every redirect in the current test read the given fake shims when its caller named none,
 * so a suite about the redirect itself never probes the host's Xcode.
 */
export function defaultRedirectProbeToFakeShims(host: FakeXcrunHost): void {
  const probe = appleRunnerTestHost.defaults().probeXcrunShimFirstLaunchHooks;
  appleRunnerTestHost.update({
    probeXcrunShimFirstLaunchHooks: async (options) =>
      await probe({ xcrunShimPaths: options?.xcrunShimPaths ?? host.xcrunShimPaths }),
  });
}
