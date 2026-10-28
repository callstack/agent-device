import fs from 'node:fs';
import path from 'node:path';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { commandDeveloperDir } from './host.ts';

/**
 * Apple toolchain identity, read from the files that `xcodebuild -version`, `xcrun
 * --show-sdk-version`, and `xcrun --show-sdk-build-version` print from. Nothing here execs: a
 * hosted macOS runner can stall an `xcrun` exec for tens of seconds, both on a fresh boot's
 * signature scan (#2422) and right after an `xcodebuild` build, and a cache key must not depend on
 * that.
 */

export type AppleSdkName =
  | 'iphonesimulator'
  | 'iphoneos'
  | 'appletvsimulator'
  | 'appletvos'
  | 'macosx'
  | 'xrsimulator'
  | 'xros';

/** Toolchain half of the runner cache key. Every field is read from the selected Xcode. */
export type RunnerToolchainFingerprint = {
  xcodeVersion: string;
  xcodeBuildVersion: string;
  sdkName: AppleSdkName;
  sdkVersion: string;
  sdkBuildVersion: string;
};

/** The `<Name>.platform` and `<Name>.sdk` that `xcrun --sdk <sdkName>` resolves in a developer dir. */
const SDK_DIRECTORY_NAMES: Record<AppleSdkName, string> = {
  iphonesimulator: 'iPhoneSimulator',
  iphoneos: 'iPhoneOS',
  appletvsimulator: 'AppleTVSimulator',
  appletvos: 'AppleTVOS',
  macosx: 'MacOSX',
  xrsimulator: 'XRSimulator',
  xros: 'XROS',
};

/** The symlink `xcode-select -s` writes and `xcode-select -p` reads back. */
export const XCODE_SELECT_LINK_PATH = '/var/db/xcode_select_link';

/** Where `xcrun` looks when neither `DEVELOPER_DIR` nor the selection link names a developer dir. */
const DEFAULT_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

const TOOLCHAIN_FILE_HINT =
  'The Apple runner cache is keyed on the toolchain version, so a cache decision cannot be made without it. Check that `xcode-select -p` or DEVELOPER_DIR names a full Xcode install.';

type BundleVersion = Readonly<{ version: string; buildVersion: string }>;

/** A toolchain file that is missing or does not carry the value the identity needs. */
class ToolchainFileError extends Error {
  readonly file: string;
  readonly detail: string;

  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.file = file;
    this.detail = detail;
  }
}

/**
 * The toolchain half of the cache key. It also names the derived-data directory, so an
 * unreadable toolchain fails the cache decision instead of standing in for one. The read
 * blocks on nothing, so an aborted owner is answered before it rather than during it.
 */
export function requireRunnerToolchainFingerprint(
  sdkName: AppleSdkName,
  signal: AbortSignal | undefined,
): RunnerToolchainFingerprint {
  if (signal?.aborted) throw createRequestCanceledError({ phase: 'apple_toolchain_identity' });
  const chosenDir = commandDeveloperDir();
  try {
    const developerDir = resolveSelectedDeveloperDir(chosenDir);
    const xcode = readXcodeVersion(developerDir);
    const sdk = readSdkVersion(developerDir, sdkName);
    return {
      xcodeVersion: xcode.version,
      xcodeBuildVersion: xcode.buildVersion,
      sdkName,
      sdkVersion: sdk.version,
      sdkBuildVersion: sdk.buildVersion,
    };
  } catch (error) {
    if (!(error instanceof ToolchainFileError)) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `Could not read the Xcode toolchain versions the Apple runner cache is keyed on (${error.message})`,
      {
        reason: 'apple_toolchain_unreadable',
        ...(chosenDir === undefined ? {} : { developerDir: chosenDir }),
        file: error.file,
        detail: error.detail,
        hint: TOOLCHAIN_FILE_HINT,
      },
    );
  }
}

/** The selected Xcode's version, for a failure report that names it; undefined when unreadable. */
export function readRunnerXcodeVersion(): string | undefined {
  try {
    return readXcodeVersion(resolveSelectedDeveloperDir(commandDeveloperDir())).version;
  } catch (error) {
    if (error instanceof ToolchainFileError) return undefined;
    throw error;
  }
}

/**
 * The developer dir `xcrun` uses, resolved to its real path: the client's `DEVELOPER_DIR`, else the
 * host's selection link, else the default Xcode when no link exists. A tool like xcodes swaps the
 * Xcode.app bundle behind a stable path, so the real path is the one that names the toolchain. Like
 * `xcrun`, it accepts an `Xcode.app` bundle for its `Contents/Developer`, and a link whose target is
 * gone is a broken selection rather than a reason to read another Xcode.
 */
function resolveSelectedDeveloperDir(chosenDir: string | undefined): string {
  const candidate = chosenDir?.trim() || selectionLinkTarget() || DEFAULT_DEVELOPER_DIR;
  const resolved = realPath(candidate) ?? candidate;
  const bundleDeveloperDir = path.join(resolved, 'Contents', 'Developer');
  return fs.existsSync(bundleDeveloperDir) ? bundleDeveloperDir : resolved;
}

function selectionLinkTarget(): string | undefined {
  try {
    fs.readlinkSync(XCODE_SELECT_LINK_PATH);
  } catch (error) {
    // No selection link: `xcrun` falls back to the default Xcode as well. Any other failure is a
    // selection this process cannot read, which must not stand in for the default Xcode.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new ToolchainFileError(XCODE_SELECT_LINK_PATH, code ?? String(error));
  }
  const target = realPath(XCODE_SELECT_LINK_PATH);
  if (target === undefined) {
    throw new ToolchainFileError(XCODE_SELECT_LINK_PATH, 'dangling selection link');
  }
  return target;
}

/** What `xcodebuild -version` prints for the Xcode that owns `developerDir`. */
function readXcodeVersion(developerDir: string): BundleVersion {
  const file = path.join(developerDir, '..', 'version.plist');
  const plist = readToolchainFile(file);
  return {
    version: plistString(plist, 'CFBundleShortVersionString', file),
    buildVersion: plistString(plist, 'ProductBuildVersion', file),
  };
}

/** What `xcrun --sdk <sdkName> --show-sdk-version` and `--show-sdk-build-version` print. */
function readSdkVersion(developerDir: string, sdkName: AppleSdkName): BundleVersion {
  const name = SDK_DIRECTORY_NAMES[sdkName];
  const sdkPath = path.join(
    developerDir,
    'Platforms',
    `${name}.platform`,
    'Developer',
    'SDKs',
    `${name}.sdk`,
  );
  const settingsFile = path.join(sdkPath, 'SDKSettings.json');
  const versionFile = path.join(sdkPath, 'System/Library/CoreServices/SystemVersion.plist');
  return {
    version: jsonString(readToolchainFile(settingsFile), 'Version', settingsFile),
    buildVersion: plistString(readToolchainFile(versionFile), 'ProductBuildVersion', versionFile),
  };
}

function realPath(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate) || undefined;
  } catch {
    return undefined;
  }
}

function readToolchainFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ToolchainFileError(file, (error as NodeJS.ErrnoException).code ?? String(error));
  }
}

/** One top-level string of an XML property list, the format of every plist read here. */
function plistString(plist: string, key: string, file: string): string {
  const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)
    .exec(plist)?.[1]
    ?.trim();
  if (!value) throw new ToolchainFileError(file, `no ${key}`);
  return value;
}

function jsonString(json: string, key: string, file: string): string {
  let value: unknown;
  try {
    value = (JSON.parse(json) as Record<string, unknown>)[key];
  } catch {
    throw new ToolchainFileError(file, 'not JSON');
  }
  if (typeof value !== 'string' || !value.trim()) throw new ToolchainFileError(file, `no ${key}`);
  return value.trim();
}
