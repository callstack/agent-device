import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.ts';

export const STUBBED_APPLE_TOOLCHAIN = {
  xcodeVersion: '26.2',
  xcodeBuildVersion: '17C52',
  sdkVersion: '26.2',
  sdkBuildVersion: '23C53',
} as const;

type StubbedToolchain = { [Key in keyof typeof STUBBED_APPLE_TOOLCHAIN]: string };

const SDK_DIRECTORY_NAMES = [
  'iPhoneSimulator',
  'iPhoneOS',
  'AppleTVSimulator',
  'AppleTVOS',
  'MacOSX',
  'XRSimulator',
  'XROS',
];

function plist(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

/**
 * An `Xcode.app` under `root` carrying the files the toolchain identity reads, for every SDK the
 * runner keys on. Returns its developer dir.
 */
export function writeXcodeFixture(
  root: string,
  toolchain: StubbedToolchain = STUBBED_APPLE_TOOLCHAIN,
): string {
  const contents = path.join(root, 'Xcode.app', 'Contents');
  const developerDir = path.join(contents, 'Developer');
  fs.mkdirSync(developerDir, { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'version.plist'),
    plist({
      CFBundleShortVersionString: toolchain.xcodeVersion,
      ProductBuildVersion: toolchain.xcodeBuildVersion,
    }),
  );
  for (const name of SDK_DIRECTORY_NAMES) {
    const sdk = path.join(developerDir, 'Platforms', `${name}.platform/Developer/SDKs/${name}.sdk`);
    fs.mkdirSync(path.join(sdk, 'System/Library/CoreServices'), { recursive: true });
    fs.writeFileSync(
      path.join(sdk, 'SDKSettings.json'),
      JSON.stringify({ Version: toolchain.sdkVersion }),
    );
    fs.writeFileSync(
      path.join(sdk, 'System/Library/CoreServices/SystemVersion.plist'),
      plist({ ProductBuildVersion: toolchain.sdkBuildVersion }),
    );
  }
  return developerDir;
}

let stubbedDeveloperDir: string | undefined;

/** One {@link STUBBED_APPLE_TOOLCHAIN} Xcode per worker, so a case never reads the host's Xcode. */
export function stubbedAppleDeveloperDir(): string {
  stubbedDeveloperDir ??= writeXcodeFixture(mkdtempForTestSync('apple-toolchain-'));
  return stubbedDeveloperDir;
}
