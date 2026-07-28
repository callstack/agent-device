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

test('producer, consumer, upload, and concurrency use the canonical artifact name', () => {
  const action = parse(fs.readFileSync('.github/actions/setup-fixture-app/action.yml', 'utf8'));
  const workflow = parse(fs.readFileSync('.github/workflows/test-app-build-cache.yml', 'utf8'));
  const fetchStep = action.runs.steps.find((step) => step.id === 'fetch');
  const fingerprintStep = workflow.jobs.fingerprint.steps.find((step) => step.id === 'fingerprint');
  const uploadStep = workflow.jobs.release.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );

  assert.match(
    fetchStep.run,
    /NAME="\$\(sh "\$GITHUB_ACTION_PATH\/resolve-artifact-name\.sh" ios\)"/,
  );
  assert.match(fetchStep.run, /find "\$REPOSITORY" "\$NAME" "\$EXPECTED_HEAD_SHA"/);
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
