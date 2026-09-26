// The build-recipe half of the Apple runner cache identity, in the words `xcodebuild` takes.
// `scripts/build-xcuitest-apple.sh` passes what this prints, and
// `scripts/write-xcuitest-cache-metadata.ts` records what the same resolvers return, so the
// compiler invocation and the cache identity cannot drift apart.
import { pathToFileURL } from 'node:url';
import {
  isRunnerXcuitestScriptPlatform,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerScriptDevice,
  resolveRunnerSigningBuildSettings,
} from '@agent-device/platform-apple/runner/operations';

const USAGE = 'Usage: xcuitest-build-settings.ts <ios|macos|tvos|visionos> <destination>';

/** The `xcodebuild` build settings `scripts/build-xcuitest-apple.sh` is about to run with. */
function resolveXcuitestBuildSettings(
  platform: string,
  destination: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isRunnerXcuitestScriptPlatform(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const device = resolveRunnerScriptDevice(platform, destination);
  return [
    ...resolveRunnerPerformanceBuildSettings(),
    ...resolveRunnerArchBuildSettings(env),
    ...resolveRunnerSandboxBuildArgs(),
    ...resolveRunnerBundleBuildSettings(env),
    ...resolveRunnerSigningBuildSettings(env, device.kind === 'device', device),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [platform, destination] = process.argv.slice(2);
  if (!platform || !destination) {
    console.error(USAGE);
    process.exit(1);
  }
  for (const setting of resolveXcuitestBuildSettings(platform, destination)) {
    process.stdout.write(`${setting}\n`);
  }
}
