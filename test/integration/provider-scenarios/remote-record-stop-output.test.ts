// #4518: what a person sees after a remote `record stop`. The chunk list names the files this
// client published, and a failed later artifact still names the file already written to cwd.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { formatCliOutput, formatHumanError } from '@agent-device/command-output';
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

async function stop(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  failArtifact: string | undefined,
  data: Record<string, unknown> & { artifacts: DaemonArtifact[] },
) {
  if (await skipWhenLoopbackUnavailable(t, 'remote record stop output')) return undefined;
  const server = http.createServer((req, res) => {
    if (failArtifact && req.url?.includes(failArtifact)) res.writeHead(500);
    res.end('video-bytes');
  });
  const port = await listenOnLoopback(server);
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-record-output-'));
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  try {
    const outcome = await materializeRemoteArtifacts(
      { baseUrl: `http://127.0.0.1:${port}`, token: 'secret' },
      { token: 'secret', command: 'record', session: 's', positionals: ['stop'], meta: { cwd } },
      { ok: true, data },
      createTestHostEnvironment(),
      path.join(root, 'state'),
    ).then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error }),
    );
    return { cwd, ...outcome };
  } finally {
    await closeLoopbackServer(server);
  }
}

test('the human record output lists the chunk paths this client published', async (t) => {
  const result = await stop(t, undefined, {
    recording: 'stopped',
    chunks: [
      { index: 0, path: '/daemon/demo.mp4' },
      { index: 1, path: '/daemon/demo.part-001.mp4' },
    ],
    artifacts: [
      { artifactId: 'c0', field: 'outPath', path: '/daemon/demo.mp4', fileName: 'demo.mp4' },
      {
        artifactId: 'c1',
        field: 'chunkPath',
        path: '/daemon/demo.part-001.mp4',
        fileName: 'demo.part-001.mp4',
      },
    ],
  });
  if (!result) return;
  assert.ok(result.response?.ok, String(result.error));
  const cli = await formatCliOutput({
    name: 'record',
    env: {},
    stderrIsTTY: false,
    input: {},
    result: result.response.data,
  });
  assert.match(cli?.text ?? '', new RegExp(`0: ${path.join(result.cwd, 'demo.mp4')}`));
  assert.match(cli?.text ?? '', new RegExp(`1: ${path.join(result.cwd, 'demo.part-001.mp4')}`));
  assert.doesNotMatch(cli?.text ?? '', /\/daemon\//);
});

test('the human error output names the recording already written to cwd', async (t) => {
  const result = await stop(t, 'telemetry', {
    artifacts: [
      { artifactId: 'video', field: 'outPath', fileName: 'demo.mp4' },
      { artifactId: 'telemetry', field: 'telemetryPath', fileName: 'demo.json' },
    ],
  });
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
