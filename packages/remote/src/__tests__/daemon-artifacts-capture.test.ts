import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts, prepareRemoteRequestArtifacts } from '../daemon-artifacts.ts';

const remote = { baseUrl: 'http://remote.example.test/agent-device', token: 'secret' };
const signal = new AbortController().signal;

test.each([
  {
    command: 'perf',
    positionals: ['memory', 'snapshot'],
    flags: { out: 'heap.hprof' },
    expected: '/client/heap.hprof',
  },
  {
    command: 'perf',
    positionals: ['cpu', 'profile', 'report', 'simpleperf', '', 'cpu.json'],
    expected: '/client/cpu.json',
  },
  {
    command: 'perf',
    positionals: ['trace', 'stop', 'perfetto', '', 'trace.data'],
    expected: '/client/trace.data',
  },
  { command: 'trace', positionals: ['start', './capture.log'], expected: '/client/capture.log' },
  { command: 'trace', positionals: ['stop', 'trace.log'], expected: '/client/trace.log' },
  {
    command: 'trace',
    positionals: ['start'],
    flags: { out: 'capture.log' },
    expected: '/client/capture.log',
  },
])(
  'remote $command destinations remain client download metadata',
  async ({ command, positionals, flags, expected }) => {
    const prepared = await prepareRemoteRequestArtifacts(
      {
        command,
        session: 'capture',
        positionals,
        flags,
        meta: { cwd: '/client' },
      },
      remote,
      signal,
      createTestHostEnvironment(),
    );
    expect(prepared.clientArtifactPaths?.outPath).toBe(expected);
  },
);

test('a remote performance observation without an output does not invent a client destination', async () => {
  const prepared = await prepareRemoteRequestArtifacts(
    {
      command: 'perf',
      session: 'capture',
      positionals: ['frames'],
    },
    remote,
    signal,
    createTestHostEnvironment(),
  );
  expect(prepared.clientArtifactPaths).toBeUndefined();
});

type MaterializationCase = {
  name: string;
  command: string;
  positionals?: string[];
  registered?: string;
  localPath: string;
  fileName: string;
  expected: string;
};

test.for<MaterializationCase>([
  {
    name: 'a registered destination wins over a response localPath',
    command: 'screenshot',
    registered: 'client/shot.png',
    localPath: 'outside/shot.png',
    fileName: 'shot.png',
    expected: 'client/shot.png',
  },
  {
    name: 'an unregistered response localPath and file name stay in cwd',
    command: 'snapshot',
    localPath: 'outside/x',
    fileName: '../../x',
    expected: 'cwd/x',
  },
  {
    name: 'a record stop accepts the echo of its start destination',
    command: 'record',
    localPath: 'client/clip.mp4',
    fileName: 'clip.mp4',
    expected: 'client/clip.mp4',
  },
  {
    name: 'a record start refuses a response localPath',
    command: 'record',
    positionals: ['start'],
    localPath: 'outside/clip.mp4',
    fileName: 'clip.mp4',
    expected: 'cwd/clip.mp4',
  },
  {
    name: 'a perf cpu profile stop accepts the echo of its start destination',
    command: 'perf',
    positionals: ['cpu', 'profile', 'stop'],
    localPath: 'client/cpu.trace',
    fileName: 'cpu.trace',
    expected: 'client/cpu.trace',
  },
])('remote artifact materialization: $name', async (c, t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote artifact download')) return;
  const root = mkdtempForTestSync('agent-device-remote-artifact-path-');
  const inRoot = (relative: string) => path.join(root, relative);
  const server = http.createServer((_req, res) => res.end('artifact-bytes'));
  try {
    const port = await listenOnLoopback(server);
    const response = await materializeRemoteArtifacts(
      { baseUrl: `http://127.0.0.1:${port}`, token: 'secret' },
      {
        token: 'secret',
        command: c.command,
        session: 'capture',
        positionals: c.positionals ?? ['stop'],
        meta: {
          cwd: inRoot('cwd'),
          ...(c.registered ? { clientArtifactPaths: { path: inRoot(c.registered) } } : {}),
        },
      },
      {
        ok: true,
        data: {
          artifacts: [
            {
              artifactId: 'a1',
              field: 'path',
              artifactType: 'screenshot',
              path: '/daemon/x',
              localPath: inRoot(c.localPath),
              fileName: c.fileName,
            },
          ],
        },
      },
      createTestHostEnvironment(),
    );
    expect(response.ok && response.data?.path).toBe(inRoot(c.expected));
    expect(fs.readFileSync(inRoot(c.expected), 'utf8')).toBe('artifact-bytes');
    expect(fs.existsSync(inRoot('outside'))).toBe(false);
  } finally {
    await closeLoopbackServer(server);
  }
});
