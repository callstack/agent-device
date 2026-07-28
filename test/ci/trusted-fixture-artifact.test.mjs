import assert from 'node:assert/strict';
import test from 'node:test';
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
