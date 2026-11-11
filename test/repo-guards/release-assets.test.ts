import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test as vitestTest } from 'vitest';
import { parse } from 'yaml';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const repo = path.resolve(import.meta.dirname, '../..');
const workflows = ['release-ios-runner.yml', 'release-android-snapshot-helper.yml'];
const test = vitestTest.skipIf(process.platform === 'win32');

type Step = {
  name: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

function fixture() {
  const root = fs.realpathSync(mkdtempForTestSync('release-assets-'));
  const scripts = path.join(root, 'scripts');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(scripts);
  fs.mkdirSync(bin);
  for (const name of [
    'release-version.mjs',
    'package-ios-simulator-runner.sh',
    'package-android-helper.sh',
  ]) {
    fs.copyFileSync(path.join(repo, 'scripts', name), path.join(scripts, name));
  }
  for (const name of [
    'mkdir',
    'dirname',
    'basename',
    'find',
    'sort',
    'head',
    'awk',
    'rm',
    'mktemp',
    'sh',
    'touch',
    'cp',
  ]) {
    const executable = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, name))
      .find((candidate) => fs.existsSync(candidate));
    assert.ok(executable, `missing ${name}`);
    fs.symlinkSync(executable, path.join(bin, name));
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const tool = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  };
  tool('shasum', String.raw`printf 'abc123  file\n'`);
  tool('ditto', 'mkdir -p "$2"');
  tool('tar', 'printf archive > "$2"');
  tool(
    'plistbuddy',
    `case "$3" in
  *xctestrun) printf '%s\\n' '__TESTROOT__/Runner.app' ;;
  *) case "$2" in *CFBundleIdentifier*) printf '%s\\n' 'com.example.runner' ;; *) printf '%s\\n' 'Runner "quoted" \\ path' ;; esac ;;
esac`,
  );
  const ios = path.join(scripts, 'package-ios-simulator-runner.sh');
  fs.writeFileSync(
    ios,
    fs.readFileSync(ios, 'utf8').replace('/usr/libexec/PlistBuddy', path.join(bin, 'plistbuddy')),
  );
  fs.writeFileSync(
    path.join(scripts, 'build-android-helper.sh'),
    `#!/bin/sh
set -eu
printf built > "$FIXTURE_BUILD_MARKER"
mkdir -p "$2"
apk="$2/agent-device-android-$AGENT_DEVICE_ANDROID_HELPER-helper-$1.apk"
printf apk > "$apk"
printf 'apk=%s\\nversion_code=123\\n' "$apk"
`,
  );
  const products = path.join(root, 'derived/Build/Products');
  fs.mkdirSync(path.join(products, 'Runner.app'), { recursive: true });
  fs.writeFileSync(path.join(products, 'fixture-iphonesimulator.xctestrun'), '');
  const env = {
    PATH: bin,
    HOME: root,
    TMPDIR: root,
    AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: path.join(root, 'derived'),
    FIXTURE_BUILD_MARKER: path.join(root, 'built'),
    GITHUB_SERVER_URL: 'https://example.invalid/"quoted"\\path',
    GITHUB_REPOSITORY: 'owner/repo',
  };
  return { root, scripts, env, marker: path.join(root, 'marker'), tool };
}

function androidBuildFixture(helper: 'snapshot' | 'ime') {
  const f = fixture();
  fs.copyFileSync(
    path.join(repo, 'scripts/build-android-helper.sh'),
    path.join(f.scripts, 'build-android-helper.sh'),
  );
  f.tool('javac', ':');
  f.tool('java', ':');
  f.tool('zip', ':');
  f.tool(
    'd8',
    `while [ "$#" -gt 0 ]; do
  case "$1" in --output) shift; printf dex > "$1/classes.dex" ;; esac
  shift
done`,
  );
  f.tool(
    'aapt2',
    String.raw`if [ "$1" = compile ]; then exit 0; fi
printf '%s\n' "$@" > "$FIXTURE_AAPT_ARGS"
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift; printf apk > "$1" ;; esac
  shift
done`,
  );
  f.tool('zipalign', 'cp "$3" "$4"');
  f.tool(
    'apksigner',
    `if [ "$1" = verify ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  case "$1" in --out) shift; output="$1" ;; esac
  shift
done
printf signed > "$output"`,
  );
  const sdk = path.join(f.root, 'sdk');
  const buildTools = path.join(sdk, 'build-tools', '36.0.0');
  const platform = path.join(sdk, 'platforms', 'android-36');
  fs.mkdirSync(buildTools, { recursive: true });
  fs.mkdirSync(platform, { recursive: true });
  fs.writeFileSync(path.join(platform, 'android.jar'), '');
  for (const name of ['aapt2', 'd8', 'zipalign', 'apksigner']) {
    fs.symlinkSync(path.join(f.env.PATH, name), path.join(buildTools, name));
  }
  const snapshot = path.join(f.root, 'android', 'snapshot-helper');
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, 'debug.keystore'), '');
  for (const sourceSet of ['main', 'test']) {
    fs.mkdirSync(path.join(f.root, 'android', `${helper}-helper`, 'src', sourceSet, 'java'), {
      recursive: true,
    });
  }
  return {
    ...f,
    env: {
      ...f.env,
      ANDROID_HOME: sdk,
      AGENT_DEVICE_ANDROID_BUILD_TOOLS: '36.0.0',
      AGENT_DEVICE_ANDROID_HELPER: helper,
      FIXTURE_AAPT_ARGS: path.join(f.root, 'aapt-args'),
    },
  };
}

function run(root: string, env: Record<string, string>, script: string, args: string[] = []) {
  return spawnSync('/bin/sh', [script, ...args], { cwd: root, env, encoding: 'utf8' });
}

function workflowSteps(workflow: string): Step[] {
  const doc = parse(fs.readFileSync(path.join(repo, '.github/workflows', workflow), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return Object.values(doc.jobs).flatMap((job) => job.steps);
}

function metadataStep(workflow: string): Step {
  const step = workflowSteps(workflow).find(
    (candidate) => candidate.name === 'Resolve release metadata',
  );
  assert.ok(step?.run);
  return step;
}

for (const workflow of workflows) {
  for (const [label, makeTag, valid] of [
    ['stable', () => 'v1.2.3', true],
    ['development', () => 'v1.2.3-dev', true],
    ['prerelease and build', () => 'v1.2.3-rc.1+build.42', true],
    ['leading zero', () => 'v01.2.3', false],
    ['leading zero prerelease', () => 'v1.2.3-01', false],
    ['newline', () => 'v1.2.3\n', false],
    ['quote', () => 'v1.2.3"bad', false],
    ['command substitution', (marker: string) => `v1.2.3$(touch ${marker})`, false],
  ] as const) {
    test(`${workflow} handles ${label} as data`, () => {
      const f = fixture();
      const historical = path.join(f.root, 'historical.mjs');
      fs.writeFileSync(historical, "console.error('unknown command'); process.exit(1);\n");
      const repositories: Record<string, Record<string, string>> = {
        caller: {
          '${{ inputs.checkout_ref || github.ref }}': historical,
          '${{ github.workflow_sha }}': historical,
          '${{ job.workflow_sha }}': historical,
        },
        '${{ job.workflow_repository }}': {
          '${{ job.workflow_sha }}': path.join(repo, 'scripts/release-version.mjs'),
        },
      };
      for (const checkout of workflowSteps(workflow).filter((step) =>
        step.name.startsWith('Checkout'),
      )) {
        const revisions = repositories[checkout.with?.repository ?? 'caller'];
        const source = revisions?.[checkout.with?.ref ?? ''];
        assert.ok(source, `unexpected checkout ref: ${checkout.with?.ref}`);
        const destination = path.join(
          f.root,
          checkout.with?.path ?? '',
          'scripts/release-version.mjs',
        );
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }
      const tag = makeTag(f.marker);
      const step = metadataStep(workflow);
      const inputExpression = '${{ inputs.release_tag }}';
      const output = path.join(f.root, 'output');
      const script = path.join(f.root, 'step.sh');
      fs.writeFileSync(script, step.run!.replaceAll(inputExpression, tag));
      const stepEnv = Object.fromEntries(
        Object.entries(step.env ?? {}).map(([key, value]) => [
          key,
          value.replaceAll(inputExpression, tag),
        ]),
      );
      const result = spawnSync('/bin/bash', [script], {
        cwd: f.root,
        env: { ...f.env, ...stepEnv, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      assert.equal(fs.existsSync(f.marker), false);
      if (valid) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, 'utf8'), `tag=${tag}\nversion=${tag.slice(1)}\n`);
      } else {
        assert.notEqual(result.status, 0, tag);
        assert.equal(fs.existsSync(output), false);
      }
    });
  }
}

test('package scripts reject invalid input before build or output', () => {
  const f = fixture();
  for (const tag of ['v1.2.3-01', 'v1.2.3\n', 'v1.2.3"bad', `v1.2.3$(touch ${f.marker})`]) {
    for (const script of ['package-ios-simulator-runner.sh', 'package-android-helper.sh']) {
      const output = path.join(f.root, 'invalid-output');
      const result = run(
        f.root,
        { ...f.env, AGENT_DEVICE_ANDROID_HELPER: 'snapshot' },
        path.join(f.scripts, script),
        ['1.2.3', tag, output],
      );
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(output), false);
      assert.equal(fs.existsSync(f.env.FIXTURE_BUILD_MARKER), false);
      assert.equal(fs.existsSync(f.marker), false);
    }
  }
});

for (const [version, tag] of [
  ['1.2.3', 'v1.2.3'],
  ['1.2.3-dev', 'v1.2.3-dev'],
  ['1.2.3-rc.1+build.42', 'v1.2.3-rc.1+build.42'],
] as const) {
  for (const helper of ['ios', 'snapshot', 'ime']) {
    for (const repository of ['', 'owner/repo']) {
      test(`${helper} ${version} manifest encodes ${repository ? 'URL' : 'null URL'} metadata`, () => {
        const f = fixture();
        const output = path.join(f.root, `${helper}-${version}-${repository ? 'url' : 'null'}`);
        const script =
          helper === 'ios' ? 'package-ios-simulator-runner.sh' : 'package-android-helper.sh';
        const args = helper === 'ime' ? [version, output] : [version, tag, output];
        const result = run(
          f.root,
          { ...f.env, GITHUB_REPOSITORY: repository, AGENT_DEVICE_ANDROID_HELPER: helper },
          path.join(f.scripts, script),
          args,
        );
        assert.equal(result.status, 0, result.stderr);
        const manifestName = fs.readdirSync(output).find((name) => name.endsWith('.manifest.json'));
        assert.ok(manifestName);
        const manifest = JSON.parse(fs.readFileSync(path.join(output, manifestName), 'utf8'));
        assert.equal(manifest.version, version);
        if (helper === 'ios') {
          assert.equal(manifest.release_tag, tag);
          assert.equal(manifest.bundle_name, String.raw`Runner "quoted" \ path`);
          assert.equal(manifest.bundle_id, 'com.example.runner');
          assert.equal(manifest.asset_name, `agent-device-ios-runner-${version}.app.tar.gz`);
          assert.equal(
            manifest.asset_url,
            repository
              ? `${f.env.GITHUB_SERVER_URL}/${repository}/releases/download/${tag}/${manifest.asset_name}`
              : null,
          );
        } else {
          assert.equal(manifest.versionCode, 123);
          assert.equal(manifest.assetName, `agent-device-android-${helper}-helper-${version}.apk`);
          if (helper === 'snapshot') {
            assert.equal(manifest.releaseTag, tag);
            assert.equal(manifest.minSdk, 23);
            assert.equal(manifest.targetSdk, 36);
            assert.equal(
              manifest.apkUrl,
              repository
                ? `${f.env.GITHUB_SERVER_URL}/${repository}/releases/download/${tag}/${manifest.assetName}`
                : null,
            );
          } else {
            assert.equal(
              manifest.serviceComponent,
              'com.callstack.agentdevice.imehelper/.TestInputMethodService',
            );
          }
        }
      });
    }
  }
}

for (const helper of ['snapshot', 'ime'] as const) {
  for (const version of ['1.2.3', '1.2.3-dev', '1.2.3+build.42', '1.2.3-rc.1+build.42']) {
    test(`${helper} ${version} preserves the base release version code`, () => {
      const f = androidBuildFixture(helper);
      const result = run(f.root, f.env, path.join(f.scripts, 'build-android-helper.sh'), [
        version,
        path.join(f.root, 'output'),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('version_code=1002003\n'));
      const args = fs.readFileSync(f.env.FIXTURE_AAPT_ARGS, 'utf8').trimEnd().split('\n');
      assert.equal(args[args.indexOf('--version-code') + 1], '1002003');
      assert.equal(args[args.indexOf('--version-name') + 1], version);
    });
  }
}
