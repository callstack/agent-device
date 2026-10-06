#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = ['ios', 'macos', 'tvos', 'visionos'];

/**
 * Compiles the Apple runner for every platform the package supports, into a scratch directory
 * under `<root>/.tmp` that is removed before and after the builds, so an interrupted run leaves
 * nothing past the next one. The package ships the runner source and the daemon builds into its
 * own keyed cache, so nothing reads these products; building them at the default
 * `~/.agent-device/apple-runner/derived` location only left about 1 GB there per machine.
 */
export function buildPackageXcuitest(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const platforms = options.platforms ?? PLATFORMS;
  const build = options.build ?? runBuildScript;
  const scratch = path.join(root, '.tmp', 'package-xcuitest');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  try {
    for (const platform of platforms) {
      build({ root, platform, derivedPath: path.join(scratch, platform) });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runBuildScript({ root, platform, derivedPath }) {
  execFileSync('sh', [path.join('scripts', 'build-xcuitest-apple.sh')], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_DEVICE_XCUITEST_PLATFORM: platform,
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: derivedPath,
    },
    stdio: 'inherit',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildPackageXcuitest();
  } catch (error) {
    process.exitCode = typeof error?.status === 'number' ? error.status : 1;
    if (typeof error?.status !== 'number') console.error(error);
  }
}
