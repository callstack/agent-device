// #4518: what a person sees after a remote `record stop`. The chunk list names the files this
// client published, and a failed later artifact still names the file already written to cwd.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { formatCliOutput, formatHumanError } from '@agent-device/command-output';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { materializeRemoteArtifacts } from '@agent-device/remote/daemon-artifacts';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { withCaptureOutputOwnership } from '../../../core/capture-output-ownership.ts';
import { finalizeDaemonResponse } from '../../../server/request-finalization.ts';
import { buildRecordingStopResponse } from '../record-runtime-response.ts';

function registeredRecordStop(overrides: Partial<ScreenRecordingCompletion> = {}) {
  const response = buildRecordingStopResponse({
    backend: 'adb screenrecord',
    outPath: '/daemon/demo.mp4',
    startedAt: 10,
    completedAt: 25,
    scope: 'device',
    showTouches: false,
    recordOnlySession: false,
    ...overrides,
  });
  assert.ok(response.ok && response.data);
  let count = 0;
  const finalized = finalizeDaemonResponse(
    { token: 'secret', command: 'record', session: 's', positionals: ['stop'] },
    { ok: true, data: withCaptureOutputOwnership(response.data, 'daemon') },
    () => `recording-${++count}`,
  );
  assert.ok(finalized.ok && finalized.data?.artifacts);
  return { ...finalized.data, artifacts: finalized.data.artifacts };
}

async function stop(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  failArtifact: string | undefined,
  data: Record<string, unknown> & { artifacts: DaemonArtifact[] },
  destinations?: (cwd: string) => Record<string, string>,
) {
  if (await skipWhenLoopbackUnavailable(t, 'remote record stop output')) return undefined;
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (failArtifact && req.url?.includes(failArtifact)) res.writeHead(500);
    res.end('video-bytes');
  });
  const port = await listenOnLoopback(server);
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-record-output-'));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  try {
    const outcome = await materializeRemoteArtifacts(
      { baseUrl: `http://127.0.0.1:${port}/proxy`, token: 'secret' },
      {
        token: 'secret',
        command: 'record',
        session: 's',
        positionals: ['stop'],
        meta: { cwd, clientArtifactPaths: destinations?.(cwd) },
      },
      { ok: true, data },
      createTestHostEnvironment(),
      path.join(root, 'state'),
    ).then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error }),
    );
    return { cwd, hits, ...outcome };
  } finally {
    await closeLoopbackServer(server);
  }
}

const CHUNKS = [
  { index: 1, path: '/daemon/demo.mp4' },
  { index: 2, path: '/daemon/demo.part-002.mp4' },
];

test('JSON and human output report both Android chunks from the registered response', async (t) => {
  const data = registeredRecordStop({ chunks: CHUNKS });
  // The registration strips daemon paths. Reverse the artifact order to exercise explicit indexes.
  assert.ok(data.artifacts.every((artifact) => artifact.path === undefined));
  const [firstArtifact, secondArtifact] = data.artifacts;
  assert.ok(firstArtifact && secondArtifact);
  const result = await stop(t, undefined, {
    ...data,
    artifacts: [{ ...secondArtifact, artifactId: 'chunk 2?#%' }, firstArtifact],
  });
  if (!result) return;
  assert.ok(result.response?.ok, String(result.error));
  assert.deepEqual(result.hits, [
    '/proxy/artifacts/chunk%202%3F%23%25',
    '/proxy/artifacts/recording-1',
  ]);
  const cli = await formatCliOutput({
    name: 'record',
    env: {},
    stderrIsTTY: false,
    input: {},
    result: result.response.data,
  });
  const first = path.join(result.cwd, 'demo.mp4');
  const second = path.join(result.cwd, 'demo.part-002.mp4');
  const json = JSON.parse(JSON.stringify(cli?.data));
  assert.equal(json.outPath, first);
  assert.deepEqual(json.chunks, [
    { index: 1, path: first },
    { index: 2, path: second },
  ]);
  assert.deepEqual(cli?.text?.split('\n'), [
    'Recording chunks:',
    `  1: ${first}`,
    `  2: ${second}`,
  ]);
  assert.doesNotMatch(cli?.text ?? '', /\/daemon\//);
});

test('the human error output names the recording already written to cwd', async (t) => {
  const result = await stop(
    t,
    'recording-2',
    registeredRecordStop({ telemetryPath: '/daemon/demo.gesture-telemetry.json' }),
  );
  if (!result) return;
  assert.ok(result.error instanceof AppError);
  const view = formatHumanError(result.error);
  assert.ok(
    view.body.some(
      (line) => line.startsWith('Warning:') && line.includes(path.join(result.cwd, 'demo.mp4')),
    ),
    view.body.join('\n'),
  );
});

test('an older daemon without artifact roles reports a typed warning and no recording paths', async (t) => {
  const data = registeredRecordStop({ chunks: CHUNKS });
  const result = await stop(t, undefined, {
    ...data,
    artifacts: data.artifacts.map((artifact, index) => ({
      ...artifact,
      role: undefined,
      chunkIndex: undefined,
      localPath: CHUNKS[index]?.path,
    })),
  });
  if (!result) return;
  assert.ok(result.response?.ok, String(result.error));
  assert.deepEqual(result.response.data?.recordingArtifactWarning, {
    reason: 'recording_artifact_role_missing',
  });
  assert.equal(result.response.data?.outPath, undefined);
  assert.equal(result.response.data?.chunks, undefined);
  assert.deepEqual(result.response.data?.artifacts, []);
  assert.deepEqual(result.hits, []);
});

test.for([
  ['unknown role', { role: 'unknown' }],
  ['contradictory type', { artifactType: 'screen-recording-telemetry' }],
  ['dot ID', { artifactId: '.' }],
  ['dot-dot ID', { artifactId: '..' }],
  ['empty ID', { artifactId: '' }],
  ['slash in ID', { artifactId: 'one/two' }],
  ['backslash in ID', { artifactId: 'one\\two' }],
] as const)('refuses %s before any transfer', async ([, changes], t) => {
  const data = registeredRecordStop();
  await assertRefused(t, {
    ...data,
    artifacts: [{ ...data.artifacts[0]!, ...changes } as DaemonArtifact],
  });
});

test('refuses a duplicate role when the peer fields differ', async (t) => {
  const data = registeredRecordStop({ telemetryPath: '/daemon/demo.gesture-telemetry.json' });
  const [recording, telemetry] = data.artifacts;
  assert.ok(recording && telemetry);
  await assertRefused(t, {
    ...data,
    artifacts: [
      recording,
      { ...telemetry, role: recording.role, artifactType: recording.artifactType },
    ],
  });
});

test('refuses a chunk index shared by two roles', async (t) => {
  const data = registeredRecordStop({ chunks: CHUNKS });
  const [recording, chunk] = data.artifacts;
  assert.ok(recording && chunk);
  await assertRefused(t, {
    ...data,
    artifacts: [recording, { ...chunk, localPath: CHUNKS[1]?.path, chunkIndex: 1 }],
  });
});

test('refuses two destinations that share a physical parent and entry name', async (t) => {
  const data = registeredRecordStop({ telemetryPath: '/daemon/demo.gesture-telemetry.json' });
  await assertRefused(t, data, (cwd) => {
    const alias = path.join(path.dirname(cwd), 'alias');
    fs.symlinkSync(cwd, alias, 'dir');
    return { telemetryPath: path.join(alias, 'demo.mp4') };
  });
});

async function assertRefused(
  t: Parameters<typeof stop>[0],
  data: Parameters<typeof stop>[2],
  destinations?: Parameters<typeof stop>[3],
) {
  const result = await stop(t, undefined, data, destinations);
  if (!result) return;
  assert.ok(result.error instanceof AppError);
  assert.equal(result.error.details?.reason, 'record_stop_answer_invalid');
  assert.deepEqual(result.hits, []);
  assert.deepEqual(fs.readdirSync(result.cwd), []);
}
