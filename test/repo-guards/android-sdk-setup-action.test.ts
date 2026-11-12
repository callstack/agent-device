import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parse } from 'yaml';
import { mkdtempForTestSync } from '@agent-device/test-kit';

// `.github/actions/setup-android-sdk` owns the pinned build-tools version and the sdkmanager
// install. The version decides the helper APK bytes, so a second copy can drift silently.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_DIR = path.join('.github', 'actions', 'setup-android-sdk');
const SCANNED_ROOTS = ['.github', 'scripts'];
const OWNED_PATTERNS = [/\b36\.0\.0\b/, /sdkmanager/];

function listFiles(relativeDir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) listFiles(relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

test('only setup-android-sdk names the build-tools version or runs sdkmanager', () => {
  const offenders = SCANNED_ROOTS.flatMap((root) => listFiles(root))
    .filter((file) => !file.startsWith(`${OWNER_DIR}${path.sep}`))
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      return OWNED_PATTERNS.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${file} matches ${pattern}`,
      );
    });
  assert.deepEqual(offenders, [], 'call ./.github/actions/setup-android-sdk instead');
});

test('setup-android-sdk lets a real licence failure stop the step', () => {
  const action = fs.readFileSync(path.join(REPO_ROOT, OWNER_DIR, 'action.yml'), 'utf8');
  assert.match(action, /set \+o pipefail\n\s*yes \| "\$SDKMANAGER" --licenses >\/dev\/null\n/);
  assert.doesNotMatch(action, /--licenses[^\n]*\|\|/);
  assert.match(action, /AGENT_DEVICE_ANDROID_BUILD_TOOLS=\$BUILD_TOOLS_VERSION" >> "\$GITHUB_ENV"/);
});

function systemImageFixture(rootVariable: 'ANDROID_HOME' | 'ANDROID_SDK_ROOT') {
  const directory = mkdtempForTestSync('sdk-system-image-');
  const sdkRoot = path.join(directory, 'sdk');
  const image = path.join(sdkRoot, 'system-images/android-36/google_apis_playstore/x86_64');
  const action = parse(fs.readFileSync(path.join(REPO_ROOT, OWNER_DIR, 'action.yml'), 'utf8')) as {
    inputs: { 'build-tools': { default: string } };
    runs: { steps: { run: string }[] };
  };
  const version = action.inputs['build-tools'].default;
  const tools = path.join(sdkRoot, 'build-tools', version);
  fs.mkdirSync(tools, { recursive: true });
  for (const tool of ['aapt', 'aapt2', 'd8', 'zipalign', 'apksigner'])
    fs.writeFileSync(path.join(tools, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(sdkRoot, 'platforms/android-36'), { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, 'platforms/android-36/android.jar'), '');
  const manager = path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager');
  fs.mkdirSync(path.dirname(manager), { recursive: true });
  const calls = path.join(directory, 'calls');
  fs.writeFileSync(
    manager,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SDK_FIXTURE_CALLS"
if [ "$1" = --install ]; then
  if [ "$#" -lt 2 ] ||
     [ "$2" != 'system-images;android-36;google_apis_playstore;x86_64' ]; then
    exit 1
  fi
  mkdir -p "$SDK_FIXTURE_IMAGE"
  printf 'Pkg.Revision=%s\\n' "$SDK_FIXTURE_REVISION" > "$SDK_FIXTURE_IMAGE/source.properties"
fi
`,
    { mode: 0o755 },
  );
  return {
    image,
    calls,
    run: (install: boolean, revision = '9') => {
      const output = path.join(directory, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', action.runs.steps[0]!.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ANDROID_HOME: rootVariable === 'ANDROID_HOME' ? sdkRoot : '',
          ANDROID_SDK_ROOT:
            rootVariable === 'ANDROID_SDK_ROOT' ? sdkRoot : path.join(directory, 'other'),
          BUILD_TOOLS_VERSION: version,
          INSTALL_SYSTEM_IMAGE: String(install),
          SDK_FIXTURE_CALLS: calls,
          SDK_FIXTURE_IMAGE: image,
          SDK_FIXTURE_REVISION: revision,
          GITHUB_OUTPUT: output,
          GITHUB_ENV: path.join(directory, 'env'),
        },
      });
      const outputs = new Map(
        fs
          .readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)] as const;
          }),
      );
      return { ...result, outputs };
    },
  };
}

test.each(['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const)(
  'system image outputs follow %s and the installed revision',
  (rootVariable) => {
    const fixture = systemImageFixture(rootVariable);
    const initial = fixture.run(false);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(initial.outputs.get('system-image-dir'), fixture.image);
    assert.equal(initial.outputs.has('system-image-revision'), false);
    assert.equal(fs.existsSync(fixture.calls), false);
    for (const revision of ['9', '10.1']) {
      const installed = fixture.run(true, revision);
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(installed.outputs.get('system-image-dir'), fixture.image);
      assert.equal(installed.outputs.get('system-image-revision'), revision);
    }
  },
);

test('an invalid installed image revision cannot produce a cache identity', () => {
  const fixture = systemImageFixture('ANDROID_HOME');
  const installed = fixture.run(true, 'invalid');
  assert.equal(installed.status, 1);
  assert.equal(installed.outputs.has('system-image-revision'), false);
});
