import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';
import { sendRemoteScriptOpen } from '../session-script-destination.ts';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
});

/**
 * Serves the script versions it is given. An artifact ID it does not know answers 503, which is how
 * these tests make one step's download fail.
 */
async function artifactServer(bodies: Record<string, string>): Promise<string> {
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace('/artifacts/', '') ?? '');
    const body = bodies[id];
    if (body === undefined) {
      res.writeHead(503).end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  servers.push(server);
  return `http://127.0.0.1:${await listenOnLoopback(server)}`;
}

function journey() {
  // The real path, so a destination names the same file the publication renames into place.
  const root = fs.realpathSync(mkdtempForTestSync('batch-script-'));
  return { root, stateDir: path.join(root, 'state'), destination: path.join(root, 'journey.ad') };
}

function request(command: string, meta: DaemonWireRequest['meta'] = {}): DaemonWireRequest {
  return { token: 't', session: 'journey', command, positionals: [], meta };
}

function script(artifactId: string, revision: number, publicationId: string): DaemonArtifact {
  return {
    field: 'savedScript',
    artifactType: 'session-script',
    artifactId,
    scriptPublicationId: publicationId,
    scriptRevision: revision,
  };
}

function records(stateDir: string): string[] {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((n) => n.endsWith('.json'))
    : [];
}

/** Answers a request the way the daemon does and materializes the answer like the client. */
function answer(
  baseUrl: string,
  stateDir: string,
  req: DaemonWireRequest,
  data: Record<string, unknown>,
): Promise<DaemonResponse> {
  return materializeRemoteArtifacts(
    { baseUrl, token: 't' },
    req,
    { ok: true, data },
    createTestHostEnvironment(),
    stateDir,
  );
}

/** One batch step result, shaped the way the daemon runner answers. */
function step(step: number, command: string, data: Record<string, unknown>) {
  return { step, command, ok: true, data, durationMs: 1 };
}

/** A remote `open --save-script` the daemon answered with version 1. */
async function open(baseUrl: string, stateDir: string, destination: string) {
  let publicationId = '';
  await sendRemoteScriptOpen(
    { baseUrl, token: 't', capabilities: ['script-artifacts'] },
    {
      ...request('open', { clientArtifactPaths: { savedScript: destination } }),
      flags: { saveScript: true },
    },
    stateDir,
    async (next) => {
      publicationId = next.meta?.scriptPublicationId as string;
      return await answer(baseUrl, stateDir, next, {
        scriptPublicationId: publicationId,
        artifacts: [script('v1', 1, publicationId)],
      });
    },
  );
  return publicationId;
}

/** The step results of a successful batch answer. */
function batchSteps(response: DaemonResponse): Array<Record<string, any>> {
  if (!response.ok) throw new Error(`Expected a successful batch, got ${JSON.stringify(response)}`);
  return (response.data?.results ?? []) as Array<Record<string, any>>;
}

test('a batch delivers each step script in step order and a close step retires the record', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v2: 'open Demo\nwait 100\n',
    v3: 'open Demo\nwait 100\nclose\n',
  });
  const id = await open(baseUrl, stateDir, destination);
  expect(records(stateDir)).toHaveLength(1);

  const response = await answer(baseUrl, stateDir, request('batch'), {
    total: 2,
    executed: 2,
    totalDurationMs: 5,
    results: [
      step(1, 'wait', { waited: true, artifacts: [script('v2', 2, id)] }),
      step(2, 'close', { scriptPublicationId: id, artifacts: [script('v3', 3, id)] }),
    ],
  });

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nclose\n');
  // The terminal step retired the record, so no later version of that publication writes anything.
  expect(records(stateDir)).toEqual([]);
  // Each step reports its own version the way the same command alone would: its `savedScript` names
  // the caller file, and its artifact carries the local path the client published.
  const steps = batchSteps(response);
  expect(steps.map((result) => result.command)).toEqual(['wait', 'close']);
  expect(steps.map((result) => result.data.savedScript)).toEqual([destination, destination]);
  expect(steps.map((result) => result.data.artifacts)).toEqual([
    [
      expect.objectContaining({
        artifactId: 'v2',
        scriptRevision: 2,
        localPath: destination,
      }),
    ],
    [
      expect.objectContaining({
        artifactId: 'v3',
        scriptRevision: 3,
        localPath: destination,
      }),
    ],
  ]);
});

test('a batch step whose download fails discloses the failure on that step and keeps the batch', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(baseUrl, stateDir, request('batch'), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'wait', { waited: true, artifacts: [script('gone', 2, id)] })],
  });

  // The step ran on the device, so the batch stands and the step says the caller file is stale.
  expect(response.ok).toBe(true);
  expect(batchSteps(response)[0]).toEqual({
    step: 1,
    command: 'wait',
    ok: true,
    durationMs: 1,
    data: expect.objectContaining({
      waited: true,
      artifacts: [],
      scriptDeliveryFailure: expect.objectContaining({
        reason: 'script_delivery_failed',
        cause: 'script_download_failed',
        publicationId: id,
      }),
      warnings: [expect.stringContaining('script')],
    }),
  });
  // A daemon-host path or status never rides along in the disclosure.
  expect(JSON.stringify(response)).not.toContain('unavailable');
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  // The recording is not closed, so the record stays and a later version still lands.
  expect(records(stateDir)).toHaveLength(1);
  const later = await answer(baseUrl, stateDir, request('close'), {
    scriptPublicationId: id,
    artifacts: [script('v1', 3, id)],
  });
  expect(later.ok).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toEqual([]);
});

test('a batch that closes keeps its success and retires the record when the final download fails', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(baseUrl, stateDir, request('batch'), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'close', { scriptPublicationId: id, artifacts: [script('gone', 2, id)] })],
  });

  // The session closed, so the record is gone even though the final script did not arrive.
  expect(batchSteps(response)[0]?.data).toEqual(
    expect.objectContaining({
      scriptDeliveryFailure: expect.objectContaining({
        cause: 'script_download_failed',
        publicationId: id,
      }),
    }),
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toEqual([]);
});

test('a batch step script of another publication or of another field writes nothing', async () => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    foreign: 'hostile\n',
  });
  const id = await open(baseUrl, stateDir, destination);
  const victim = path.join(root, 'victim.ad');

  const response = await answer(baseUrl, stateDir, request('batch'), {
    total: 2,
    executed: 2,
    totalDurationMs: 1,
    results: [
      // Another publication's version, and one under a field this owner does not claim.
      step(1, 'wait', {
        artifacts: [script('foreign', 9, '00000000-0000-4000-8000-000000000000')],
      }),
      step(2, 'wait', {
        artifacts: [{ ...script('foreign', 8, id), field: 'path', fileName: 'victim.ad' }],
      }),
    ],
  });

  expect(batchSteps(response).map((result) => result.data)).toEqual([
    { artifacts: [] },
    { artifacts: [] },
  ]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(fs.existsSync(victim)).toBe(false);
});

test('a batch answer with no step scripts is returned untouched', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  await open(baseUrl, stateDir, destination);
  const data = {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'wait', { waited: true })],
  };

  const response = await answer(baseUrl, stateDir, request('batch'), data);

  expect(response).toEqual({ ok: true, data });
});
