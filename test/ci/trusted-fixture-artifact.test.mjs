import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  classifyProducerState,
  findTrustedArtifact,
} from '../../.github/actions/setup-fixture-app/trusted-artifact.mjs';
import { assertAndroidFixtureSnapshot } from '../scripts/assert-android-fixture-snapshot.mjs';

const repository = { default_branch: 'main', id: 42 };
const trustedRun = {
  event: 'pull_request',
  head_branch: 'feature',
  head_repository: { id: 42 },
  head_sha: 'current-head',
  path: '.github/workflows/test-app-build-cache.yml',
  repository: { id: 42 },
  status: 'in_progress',
};

test('producer, consumers, upload, and concurrency use the canonical platform-scoped artifact name', () => {
  const action = parse(fs.readFileSync('.github/actions/setup-fixture-app/action.yml', 'utf8'));
  const workflow = parse(fs.readFileSync('.github/workflows/test-app-build-cache.yml', 'utf8'));
  const fetchStep = action.runs.steps.find((step) => step.id === 'fetch');
  const androidBuildToolsStep = action.runs.steps.find(
    (step) => step.name === 'Ensure Android artifact build tools',
  );
  const androidFallbackStep = action.runs.steps.find(
    (step) => step.name === 'Build the Android Release APK (fallback)',
  );
  const fingerprintStep = workflow.jobs.fingerprint.steps.find((step) => step.id === 'fingerprint');
  const uploadStep = workflow.jobs.release.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );

  const fetchArtifact = fs.readFileSync(
    '.github/actions/setup-fixture-app/fetch-artifact.sh',
    'utf8',
  );

  assert.match(fetchStep.run, /"\$\{\{ inputs\.platform \}\}" "\$DEST"/);
  assert.match(fetchArtifact, /resolve-artifact-name\.sh" "\$PLATFORM"/);
  assert.match(fetchArtifact, /find "\$REPOSITORY" "\$NAME" "\$EXPECTED_HEAD_SHA"/);
  assert.match(androidBuildToolsStep.run, /build-tools;36\.0\.0/);
  assert.match(androidBuildToolsStep.run, /apksigner/);
  assert.match(androidBuildToolsStep.run, /set \+o pipefail/);
  assert.match(androidFallbackStep.if, /inputs\.platform == 'android'/);
  assert.match(androidFallbackStep.run, /expo prebuild --platform android --no-install/);
  assert.match(androidFallbackStep.run, /:app:assembleRelease/);
  assert.match(
    fingerprintStep.run,
    /ARTIFACT_NAME_RESOLVER="\.github\/actions\/setup-fixture-app\/resolve-artifact-name\.sh"/,
  );
  assert.match(fingerprintStep.run, /IOS_NAME="\$\(sh "\$ARTIFACT_NAME_RESOLVER" ios\)"/);
  assert.match(fingerprintStep.run, /ANDROID_NAME="\$\(sh "\$ARTIFACT_NAME_RESOLVER" android\)"/);
  assert.equal(uploadStep.with.name, '${{ matrix.artifactName }}');
  assert.equal(
    workflow.jobs.release.concurrency.group,
    'test-app-${{ matrix.artifactName }}-${{ github.event.pull_request.number || github.ref_name }}',
  );
});

test('Android smoke keeps its install/open/snapshot evidence in a checked-in script', (t) => {
  const workflow = parse(fs.readFileSync('.github/workflows/android.yml', 'utf8'));
  const smokeStep = workflow.jobs['smoke-android'].steps.find(
    (step) => step.name === 'Run Android smoke checks',
  );
  const restoreStep = workflow.jobs['smoke-android'].steps.find(
    (step) => step.name === 'Restore fixture APK',
  );
  const sourceStep = workflow.jobs['smoke-android'].steps.find(
    (step) => step.name === 'Report fixture cache source',
  );
  const assertion = fs.readFileSync('test/scripts/assert-android-fixture-snapshot.mjs', 'utf8');
  const smokeScript = fs.readFileSync('test/scripts/android-fixture-cache-smoke.sh', 'utf8');
  const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

  assert.match(smokeStep.with.script, /android-fixture-cache-smoke\.sh/);
  assert.match(smokeStep.with.script, /steps\.fixture-app\.outputs\.apk-path/);
  assert.match(smokeStep.with.script, /steps\.fixture-app\.outputs\.app-id/);
  assert.equal(restoreStep.with['wait-for-artifact-seconds'], '600');
  assert.match(sourceStep.run, /steps\.fixture-app\.outputs\.source/);
  assert.match(smokeScript, /snapshot -i .*--json > "\$SNAPSHOT_PATH"/);
  assert.match(smokeScript, /\[ -z "\$1" \] \|\| \[ -z "\$2" \]/);
  assert.match(smokeScript, /assert-android-fixture-snapshot\.mjs/);
  assert.match(assertion, /metadata\.backend !== 'android-helper'/);
  assert.match(assertion, /metadata\.helperVersion !== packageVersion/);
  assert.match(assertion, /Agent Device Tester/);
  assert.throws(
    () =>
      assertAndroidFixtureSnapshot(
        { success: true, data: { androidSnapshot: { backend: 'uiautomator' }, nodes: [] } },
        'com.callstack.agentdevicelab',
        packageVersion,
      ),
    /Expected android-helper backend/,
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-android-snapshot-'));
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));
  const snapshotPath = path.join(tempRoot, 'snapshot.json');
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      success: true,
      data: {
        appBundleId: 'com.callstack.agentdevicelab',
        androidSnapshot: { backend: 'android-helper', helperVersion: packageVersion },
        nodes: [{ label: 'Agent Device Tester' }],
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      'test/scripts/assert-android-fixture-snapshot.mjs',
      snapshotPath,
      'com.callstack.agentdevicelab',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      success: true,
      data: {
        appBundleId: 'com.callstack.agentdevicelab',
        androidSnapshot: { backend: 'android-helper', helperVersion: 'stale-helper' },
        nodes: [{ label: 'Agent Device Tester' }],
      },
    }),
  );
  const staleHelper = spawnSync(
    process.execPath,
    [
      'test/scripts/assert-android-fixture-snapshot.mjs',
      snapshotPath,
      'com.callstack.agentdevicelab',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.notEqual(staleHelper.status, 0);
  assert.match(staleHelper.stderr, /Expected helper version/);
});

test('Android APK locator emits an exact APK path and package id, and rejects collisions or malformed artifacts', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-android-apk-'));
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));
  const apkDir = path.join(tempRoot, 'apk');
  const binDir = path.join(tempRoot, 'build-tools', '36.0.0');
  const outputPath = path.join(tempRoot, 'output');
  fs.mkdirSync(apkDir);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'aapt'),
    [
      '#!/bin/sh',
      'if [ "${TEST_AAPT_FAIL:-}" = 1 ]; then exit 23; fi',
      'if [ -n "$TEST_AAPT_PACKAGE" ]; then',
      '  printf "package: name=\'%s\' versionCode=1 versionName=1\\n" "$TEST_AAPT_PACKAGE"',
      'fi',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(binDir, 'aapt'), 0o755);
  const runLocator = (packageId, aaptFails = false) =>
    spawnSync('bash', ['.github/actions/setup-fixture-app/locate-android-apk.sh', apkDir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ANDROID_HOME: tempRoot,
        GITHUB_OUTPUT: outputPath,
        PATH: `${binDir}:${process.env.PATH}`,
        TEST_AAPT_PACKAGE: packageId,
        TEST_AAPT_FAIL: aaptFails ? '1' : '',
      },
    });

  fs.writeFileSync(path.join(apkDir, 'fixture-app.apk'), 'not-a-real-apk');
  let result = runLocator('com.example.fixture');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    `app-path=${path.join(apkDir, 'fixture-app.apk')}\napp-id=com.example.fixture\n`,
  );

  fs.writeFileSync(path.join(apkDir, 'another.apk'), 'not-a-real-apk');
  result = runLocator('com.example.fixture');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly one fixture APK/);

  fs.rmSync(path.join(apkDir, 'another.apk'));
  result = runLocator('');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has no readable package id/);

  result = runLocator('com.example.fixture', true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /it may be malformed/);
});

test('Android APK repack signs the output and preserves its package id', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-android-repack-'));
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));
  const buildTools = path.join(tempRoot, 'build-tools', '36.0.0');
  const binDir = path.join(tempRoot, 'bin');
  const source = path.join(tempRoot, 'source.apk');
  const output = path.join(tempRoot, 'output', 'fixture.apk');
  const commandLog = path.join(tempRoot, 'commands');
  fs.mkdirSync(buildTools, { recursive: true });
  fs.mkdirSync(binDir);
  fs.writeFileSync(source, 'fixture');
  fs.writeFileSync(
    path.join(buildTools, 'aapt'),
    [
      '#!/bin/sh',
      'printf "package: name=\'com.example.fixture\' versionCode=1 versionName=1\\n"',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(buildTools, 'apksigner'),
    [
      '#!/bin/sh',
      'if [ "$1" != verify ] || [ ! -f "$3" ]; then exit 2; fi',
      'if [ "${2:-}" = --print-certs ]; then',
      '  digest="$TEST_SOURCE_DIGEST"',
      '  if [ "$3" = "$TEST_REPACK_OUTPUT" ]; then digest="$TEST_OUTPUT_DIGEST"; fi',
      '  printf "Signer #1 certificate SHA-256 digest: %s\\n" "$digest"',
      'fi',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(binDir, 'pnpm'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$TEST_COMMAND_LOG"',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --source-app) source="$2"; shift 2 ;;',
      '    --output) output="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'mkdir -p "$(dirname "$output")"',
      'cp "$source" "$output"',
      '',
    ].join('\n'),
  );
  for (const executable of [
    path.join(buildTools, 'aapt'),
    path.join(buildTools, 'apksigner'),
    path.join(binDir, 'pnpm'),
  ]) {
    fs.chmodSync(executable, 0o755);
  }

  const runRepack = (repackOutput, outputDigest = 'source-digest') =>
    spawnSync(
      'bash',
      ['.github/actions/setup-fixture-app/repack-android-apk.sh', source, repackOutput],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          ANDROID_HOME: tempRoot,
          PATH: `${binDir}:${process.env.PATH}`,
          TEST_COMMAND_LOG: commandLog,
          TEST_REPACK_OUTPUT: repackOutput,
          TEST_SOURCE_DIGEST: 'source-digest',
          TEST_OUTPUT_DIGEST: outputDigest,
        },
      },
    );

  const result = runRepack(output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'fixture');
  assert.match(
    fs.readFileSync(commandLog, 'utf8'),
    /repack-app --platform android --source-app .*source\.apk --output .*fixture\.apk .*--js-bundle-only/,
  );

  const mismatchedOutput = path.join(tempRoot, 'output', 'mismatched.apk');
  const mismatch = runRepack(mismatchedOutput, 'different-digest');
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /did not preserve the source signing certificate/);
});

test('producer maps each platform to its resolved lookup and matrix artifact name', (t) => {
  const workflow = parse(fs.readFileSync('.github/workflows/test-app-build-cache.yml', 'utf8'));
  const fingerprintStep = workflow.jobs.fingerprint.steps.find((step) => step.id === 'fingerprint');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-producer-name-'));
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));
  const actionDir = path.join(tempRoot, '.github/actions/setup-fixture-app');
  const binDir = path.join(tempRoot, 'bin');
  const outputPath = path.join(tempRoot, 'output');
  const resolverLog = path.join(tempRoot, 'resolver-calls');
  const nodeLog = path.join(tempRoot, 'node-calls');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(actionDir, 'resolve-artifact-name.sh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$1" >> "$TEST_RESOLVER_LOG"',
      'printf "fingerprint.%s-hash.%s\\n" "$1" "$1"',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(binDir, 'node'),
    ['#!/bin/sh', 'printf "%s\\n" "$*" >> "$TEST_NODE_LOG"', ''].join('\n'),
  );
  fs.chmodSync(path.join(binDir, 'node'), 0o755);
  const run = fingerprintStep.run
    .replaceAll('${{ github.event.pull_request.head.sha || github.sha }}', 'current-head')
    .replaceAll('${{ github.repository }}', 'octo/repo')
    .replaceAll('${{ github.event_name }}', 'pull_request')
    .replaceAll('${{ github.event.pull_request.head.repo.full_name }}', 'octo/repo');
  const result = spawnSync('bash', ['-c', run], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      PATH: `${binDir}:${process.env.PATH}`,
      TEST_NODE_LOG: nodeLog,
      TEST_RESOLVER_LOG: resolverLog,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const matrixLine = fs.readFileSync(outputPath, 'utf8').trim();
  assert.match(matrixLine, /^matrix=/);
  const matrix = JSON.parse(matrixLine.slice('matrix='.length));
  assert.deepEqual(
    matrix.include.map(({ platform, artifactName }) => ({ platform, artifactName })),
    [
      { platform: 'ios', artifactName: 'fingerprint.ios-hash.ios' },
      { platform: 'android', artifactName: 'fingerprint.android-hash.android' },
    ],
  );
  assert.deepEqual(fs.readFileSync(resolverLog, 'utf8').trim().split('\n'), ['ios', 'android']);
  assert.deepEqual(fs.readFileSync(nodeLog, 'utf8').trim().split('\n'), [
    '.github/actions/setup-fixture-app/trusted-artifact.mjs find octo/repo fingerprint.ios-hash.ios current-head',
    '.github/actions/setup-fixture-app/trusted-artifact.mjs find octo/repo fingerprint.android-hash.android current-head',
  ]);
});

test('artifact name resolver scopes both platforms and rejects invalid output', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-artifact-name-'));
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));
  const callLog = path.join(tempRoot, 'calls');
  const pnpmStub = path.join(tempRoot, 'pnpm');
  fs.writeFileSync(
    pnpmStub,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$TEST_CALL_LOG"',
      'if [ "$TEST_PNPM_EXIT" -ne 0 ]; then exit "$TEST_PNPM_EXIT"; fi',
      'if [ -n "$TEST_RAW_OUTPUT" ]; then',
      '  printf "%s\\n" "$TEST_RAW_OUTPUT"',
      'else',
      '  printf \'{"hash":"%s"}\\n\' "$TEST_HASH"',
      'fi',
      '',
    ].join('\n'),
  );
  fs.chmodSync(pnpmStub, 0o755);
  const resolver = '.github/actions/setup-fixture-app/resolve-artifact-name.sh';
  const runResolver = (platform, hash, pnpmExit = 0, rawOutput = '') =>
    spawnSync('sh', platform === undefined ? [resolver] : [resolver, platform], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH}`,
        TEST_CALL_LOG: callLog,
        TEST_HASH: hash,
        TEST_PNPM_EXIT: String(pnpmExit),
        TEST_RAW_OUTPUT: rawOutput,
      },
    });

  const ios = runResolver('ios', 'ios-hash');
  assert.equal(ios.status, 0, ios.stderr);
  assert.equal(ios.stdout, 'fingerprint.ios-hash.ios\n');

  const android = runResolver('android', 'android-hash');
  assert.equal(android.status, 0, android.stderr);
  assert.equal(android.stdout, 'fingerprint.android-hash.android\n');

  assert.deepEqual(fs.readFileSync(callLog, 'utf8').trim().split('\n'), [
    '--dir examples/test-app exec fingerprint fingerprint:generate --platform ios',
    '--dir examples/test-app exec fingerprint fingerprint:generate --platform android',
  ]);
  assert.equal(runResolver(undefined, 'unused').status, 2);
  assert.equal(
    spawnSync('sh', [resolver, 'ios', 'extra'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
    }).status,
    2,
  );
  assert.equal(runResolver('windows', 'unused').status, 2);
  assert.equal(runResolver('ios', 'null').status, 1);
  assert.equal(runResolver('ios', 'bad/hash').status, 1);
  assert.equal(runResolver('ios', 'unused', 0, '{"hash":"bad\\nhash"}').status, 1);
  assert.equal(runResolver('ios', 'unused', 0, '{"hash":"first"}\n{"hash":"second"}').status, 1);
  assert.equal(runResolver('ios', 'unused', 17).status, 17);
});

test('same-name artifact from an untrusted repository cannot suppress a trusted candidate', async () => {
  const artifacts = [
    {
      expired: false,
      id: 100,
      workflow_run: { head_repository_id: 7, id: 10, repository_id: 42 },
    },
    {
      expired: false,
      id: 200,
      workflow_run: { head_repository_id: 42, id: 20, repository_id: 42 },
    },
  ];
  const loaded = [];
  const artifactId = await findTrustedArtifact({
    artifacts,
    expectedHeadSha: 'current-head',
    repository,
    loadRun: async (runId) => {
      loaded.push(runId);
      return trustedRun;
    },
  });
  assert.equal(artifactId, 200);
  assert.deepEqual(loaded, [20]);
});

test('same-name artifact from another workflow falls back instead of being executed', async () => {
  const artifactId = await findTrustedArtifact({
    artifacts: [
      {
        expired: false,
        id: 100,
        workflow_run: { head_repository_id: 42, id: 10, repository_id: 42 },
      },
    ],
    expectedHeadSha: 'current-head',
    repository,
    loadRun: async () => ({ ...trustedRun, path: '.github/workflows/untrusted.yml' }),
  });
  assert.equal(artifactId, undefined);
});

test('same-repository artifact from an unrelated feature head is rejected', async () => {
  const artifactId = await findTrustedArtifact({
    artifacts: [
      {
        expired: false,
        id: 100,
        workflow_run: { head_repository_id: 42, id: 10, repository_id: 42 },
      },
    ],
    expectedHeadSha: 'current-head',
    repository,
    loadRun: async () => ({ ...trustedRun, head_sha: 'another-feature-head' }),
  });
  assert.equal(artifactId, undefined);
});

test('default-branch producer artifacts remain reusable across native-equivalent heads', async () => {
  const artifactId = await findTrustedArtifact({
    artifacts: [
      {
        expired: false,
        id: 300,
        workflow_run: { head_repository_id: 42, id: 30, repository_id: 42 },
      },
    ],
    expectedHeadSha: 'current-head',
    repository,
    loadRun: async () => ({
      ...trustedRun,
      event: 'push',
      head_branch: 'main',
      head_sha: 'older-main-head',
    }),
  });
  assert.equal(artifactId, 300);
});

test('producer state is derived only from the trusted exact-head workflow run', () => {
  assert.equal(
    classifyProducerState([], { expectedHeadSha: 'current-head', repository }),
    'absent',
  );
  assert.equal(
    classifyProducerState([{ ...trustedRun, status: 'queued' }], {
      expectedHeadSha: 'current-head',
      repository,
    }),
    'queued',
  );
  assert.equal(
    classifyProducerState([{ ...trustedRun, conclusion: 'failure', status: 'completed' }], {
      expectedHeadSha: 'current-head',
      repository,
    }),
    'failed',
  );
  assert.equal(
    classifyProducerState([{ ...trustedRun, conclusion: 'success', status: 'completed' }], {
      expectedHeadSha: 'current-head',
      repository,
    }),
    'success',
  );
});
