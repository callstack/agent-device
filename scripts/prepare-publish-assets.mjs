#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS = [
  {
    name: 'snapshot',
    directory: path.join('android', 'snapshot-helper', 'dist'),
    releaseTag: true,
  },
  {
    name: 'ime',
    directory: path.join('android', 'ime-helper', 'dist'),
    releaseTag: false,
  },
];

export function preparePublishAssets(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const version = readPackageVersion(root);
  const packageAppleRunnerScript = path.join(root, 'scripts', 'package-apple-runner-source.mjs');
  const packageAndroidHelperScript = path.join(root, 'scripts', 'package-android-helper.sh');

  run(process.execPath, [packageAppleRunnerScript, '--quiet'], root);
  for (const helper of HELPERS) {
    const outputDirectory = path.join(root, helper.directory);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    const helperArguments = [version];
    if (helper.releaseTag) helperArguments.push(`v${version}`);
    helperArguments.push(outputDirectory);
    run('sh', [packageAndroidHelperScript, ...helperArguments], root, {
      AGENT_DEVICE_ANDROID_HELPER: helper.name,
    });
  }

  assertPreparedAssets(root, version);
  return { root, version };
}

function readPackageVersion(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json must declare a non-empty version');
  }
  return packageJson.version;
}

function run(command, arguments_, root, environment = {}) {
  execFileSync(command, arguments_, {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function assertPreparedAssets(root, version) {
  for (const helper of HELPERS) {
    const directory = path.join(root, helper.directory);
    for (const suffix of ['.apk', '.manifest.json', '.apk.sha256']) {
      const filePath = path.join(
        directory,
        `agent-device-android-${helper.name}-helper-${version}${suffix}`,
      );
      if (!isNonEmptyFile(filePath)) {
        throw new Error(`Publish asset was not prepared: ${filePath}`);
      }
    }
  }
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const result = preparePublishAssets();
  process.stdout.write(`Prepared publish assets for ${result.version}.\n`);
}
