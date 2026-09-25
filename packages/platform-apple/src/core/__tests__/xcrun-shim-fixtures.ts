import fs from 'node:fs';
import path from 'node:path';
import type { ExecResult } from '@agent-device/host-kit/command';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { XCRUN_SHIM_TOOL_NAMES, type XcrunShimToolName } from '../xcrun-shim-first-launch.ts';

/**
 * The fake Xcode `xcrun` shims every first-launch probe test reads (#2935). Hooked shims are the
 * captured Xcode 26.2 `simctl` shim with its version and Info.plist path swapped, and installed
 * versions are answered by a fake plist reader, so no test runs `xcrun`, `plutil`, or reads the
 * host's Xcode.
 */
export const XCODE_26_2_SIMCTL_SHIM = {
  command: 'cat "$(xcrun --find simctl)"',
  xcodeVersion: 'Xcode 26.2 (17C52)',
  expectedVersion: '1051.17.7',
  infoPlistPath:
    '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist',
  text: [
    '#!/bin/bash',
    'DEVELOPER_USR_BIN_DIR=${0%/*}',
    'DEVELOPER_USR_BIN_DIR=${DEVELOPER_USR_BIN_DIR%/local/bin}',
    'DEVELOPER_USR_BIN_DIR=${DEVELOPER_USR_BIN_DIR%/bin}',
    'DEVELOPER_USR_BIN_DIR=${DEVELOPER_USR_BIN_DIR}/bin',
    'DEVELOPER_USR_DIR=${DEVELOPER_USR_BIN_DIR%/*}',
    'export DEVELOPER_DIR=${DEVELOPER_USR_DIR%/*}',
    '',
    'EXPECTED_VERSION="1051.17.7"',
    'CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist" 2>&1)"',
    '',
    'if [[ "${EXPECTED_VERSION}" != "${CURRENT_VERSION}" ]]; then',
    '    "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
    'fi',
    'exec "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl" "${@}"',
    '',
  ].join('\n'),
} as const;

export function hookedShimText(expectedVersion: string, infoPlistPath: string): string {
  return XCODE_26_2_SIMCTL_SHIM.text
    .replace(
      `EXPECTED_VERSION="${XCODE_26_2_SIMCTL_SHIM.expectedVersion}"`,
      `EXPECTED_VERSION="${expectedVersion}"`,
    )
    .replace(`"${XCODE_26_2_SIMCTL_SHIM.infoPlistPath}"`, `"${infoPlistPath}"`);
}

export type FakeXcrunShim =
  | { expectedVersion: string; installedVersion: string }
  | { hook: 'none' }
  | { text: string | Buffer };

export type FakeXcrunHost = {
  xcrunShimPaths: Partial<Record<XcrunShimToolName, string>>;
  /** `CFBundleVersion` by Info.plist path; a path left out reads as an unreadable plist. */
  installedVersions: Map<string, string>;
  /** Every tool `xcrun --find` was asked for, in call order. */
  finds: string[];
  /** Every Info.plist path the probe asked for, in call order. */
  plistReads: string[];
  /** Runs as each Info.plist read starts, before it is answered. */
  onPlistRead?: () => void;
};

const HOOKLESS_SHIM_TEXT = '#!/bin/bash\nexec "${DEVELOPER_DIR}/usr/bin/tool" "${@}"\n';

const FAKE_FRAMEWORK_NAMES: Record<XcrunShimToolName, string> = {
  simctl: 'CoreSimulator',
  devicectl: 'CoreDevice',
};

/** Where a fake tool's framework Info.plist lives under `root`. */
export function fakeFrameworkInfoPlistPath(root: string, tool: XcrunShimToolName): string {
  return path.join(root, `${FAKE_FRAMEWORK_NAMES[tool]}.framework`, 'Info.plist');
}

/** Writes one shim file per listed tool; a tool left out is absent from `xcrunShimPaths`. */
export function writeFakeXcrunShims(
  root: string,
  shims: Readonly<Partial<Record<XcrunShimToolName, FakeXcrunShim>>>,
): FakeXcrunHost {
  const shimDir = path.join(root, 'xcrun-shims');
  fs.mkdirSync(shimDir, { recursive: true });
  const host: FakeXcrunHost = {
    xcrunShimPaths: {},
    installedVersions: new Map(),
    finds: [],
    plistReads: [],
  };
  for (const tool of XCRUN_SHIM_TOOL_NAMES) {
    const shim = shims[tool];
    if (!shim) continue;
    const plistPath = fakeFrameworkInfoPlistPath(root, tool);
    let text: string | Buffer = HOOKLESS_SHIM_TEXT;
    if ('expectedVersion' in shim) {
      text = hookedShimText(shim.expectedVersion, plistPath);
      host.installedVersions.set(plistPath, shim.installedVersion);
    } else if ('text' in shim) {
      text = shim.text;
    }
    const shimPath = path.join(shimDir, tool);
    fs.writeFileSync(shimPath, text);
    host.xcrunShimPaths[tool] = shimPath;
  }
  return host;
}

/**
 * Runs `task` with `xcrun --find` answered from `host.xcrunShimPaths` and every Info.plist read
 * answered from the fake shims' installed versions, both recorded on `host`.
 */
export async function withFakeXcrunHost<T>(
  host: FakeXcrunHost,
  task: () => Promise<T>,
): Promise<T> {
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args): Promise<ExecResult> => {
      const tool = cmd === 'xcrun' && args[0] === '--find' ? args[1] : undefined;
      if (tool !== undefined) host.finds.push(tool);
      const found = tool === undefined ? undefined : host.xcrunShimPaths[tool as XcrunShimToolName];
      return found
        ? { exitCode: 0, stdout: `${found}\n`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: `xcrun: error: unable to find utility "${tool}"` };
    },
    plist: {
      readJson: async (plistPath) => {
        host.plistReads.push(plistPath);
        host.onPlistRead?.();
        const version = host.installedVersions.get(plistPath);
        return version === undefined ? null : { CFBundleVersion: version };
      },
    },
  });
  return await withAppleToolProvider(provider, task);
}
