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

function request(
  command: string,
  meta: DaemonWireRequest['meta'] = {},
  flags?: DaemonWireRequest['flags'],
): DaemonWireRequest {
  return {
    token: 't',
    session: 'journey',
    command,
    positionals: [],
    ...(flags ? { flags } : {}),
    meta,
  };
}

/**
 * The plan a `batch` request carries: the daemon answers one entry per submitted step, and the
 * client authorizes delivery only for the steps IT submitted (#4564 review).
 */
function batchPlan(...commands: string[]): DaemonWireRequest['flags'] {
  return { batchSteps: commands.map((command) => ({ command })) };
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

/**
 * Nothing was delivered: no step names a caller file, and no artifact reports a published local
 * path. The daemon's own artifact entries stay in the answer, field names and all, so the answer is
 * checked for what this client would have added.
 */
function expectDeliveredNothing(response: DaemonResponse): void {
  const text = JSON.stringify(response);
  expect(text).not.toContain('"savedScript":');
  expect(text).not.toContain('"localPath":');
  expect(text).not.toContain('"scriptDeliveryFailure":');
}

test('a batch delivers its newest script once and a close step retires the record', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v2: 'open Demo\nwait 100\n',
    v3: 'open Demo\nwait 100\nclose\n',
  });
  const id = await open(baseUrl, stateDir, destination);
  expect(records(stateDir)).toHaveLength(1);

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'close')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 5,
      results: [
        step(1, 'wait', { waited: true, artifacts: [script('v2', 2, id)] }),
        step(2, 'close', { scriptPublicationId: id, artifacts: [script('v3', 3, id)] }),
      ],
    },
  );

  // Every version is the whole recording, so ONE download is owed: the newest of the batch.
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nclose\n');
  // The terminal step retired the record, so no later version of that publication writes anything.
  expect(records(stateDir)).toEqual([]);
  // The batch's own payload says where the recording landed, the way a single response does.
  expect(response.ok && response.data?.savedScript).toBe(destination);
  // The steps are reported exactly as the daemon answered them: this client writes its own fields, not
  // the daemon's entries.
  expect(batchSteps(response).map((result) => result.command)).toEqual(['wait', 'close']);
  expect(batchSteps(response).map((result) => result.data.artifacts)).toEqual([
    [expect.objectContaining({ artifactId: 'v2', scriptRevision: 2 })],
    [expect.objectContaining({ artifactId: 'v3', scriptRevision: 3 })],
  ]);
});

test('a batch script whose download fails discloses the failure and keeps the batch', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('wait')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'wait', { waited: true, artifacts: [script('gone', 2, id)] })],
  });

  // The step ran on the device, so the batch stands and the batch payload says the file is stale.
  expect(response.ok).toBe(true);
  expect(response.ok && response.data?.scriptDeliveryFailure).toEqual(
    expect.objectContaining({
      reason: 'script_delivery_failed',
      cause: 'script_download_failed',
      publicationId: id,
    }),
  );
  expect(response.ok && response.data?.warnings).toEqual([expect.stringContaining('script')]);
  // The step's own entry is the daemon's answer, and a daemon-host path or status never rides along.
  expect(batchSteps(response)[0]).toEqual({
    step: 1,
    command: 'wait',
    ok: true,
    durationMs: 1,
    data: { waited: true, artifacts: [expect.objectContaining({ artifactId: 'gone' })] },
  });
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

  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('close')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'close', { scriptPublicationId: id, artifacts: [script('gone', 2, id)] })],
  });

  // The session closed, so the record is gone even though the final script did not arrive.
  expect(response.ok && response.data?.scriptDeliveryFailure).toEqual(
    expect.objectContaining({
      cause: 'script_download_failed',
      publicationId: id,
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

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'wait')),
    {
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
    },
  );

  expectDeliveredNothing(response);
  expect(batchSteps(response).map((result) => result.step)).toEqual([1, 2]);
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

  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('wait')), data);

  expect(response).toEqual({ ok: true, data });
});

test('a close step that names the publication retires the record with no artifact to deliver', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  // The daemon could not write the final version, so it answers this close with its own typed
  // failure and nothing to download. The caller still has to stop tracking a recording it lost.
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('close')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [
      step(1, 'close', {
        scriptPublicationId: id,
        scriptDeliveryFailure: { reason: 'script_delivery_failed', publicationId: id },
        warnings: ['The daemon could not write the final script.'],
      }),
    ],
  });

  expect(records(stateDir)).toEqual([]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  // The daemon's own warning stands on its step, and reaches the batch's top level as well.
  expect(batchSteps(response)[0]?.data).toEqual(
    expect.objectContaining({ scriptPublicationId: id }),
  );
  expect(response.ok && response.data?.warnings).toEqual([
    'The daemon could not write the final script.',
  ]);
});

test('a batch step entry the plan does not authorize delivers nothing and retires nothing', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v2: 'open Demo\nwait 100\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  // The caller submitted two `wait` steps. This answer plants a closing step in the second position,
  // names this client's publication, and offers the artifact it claims the caller wrote.
  const planted = step(2, 'close', {
    scriptPublicationId: id,
    artifacts: [script('v2', 2, id)],
  });
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'wait')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [step(1, 'wait', { waited: true }), planted],
    },
  );

  // The planted entry is reported exactly as the daemon answered it, with its artifact still remote.
  expect(batchSteps(response)[1]).toEqual(planted);
  // The caller's recording was never closed, so its record and its file stand untouched.
  expect(records(stateDir)).toHaveLength(1);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expectDeliveredNothing(response);
});

test('a batch step entry out of position or not successful authorizes no delivery', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v2: 'open Demo\nwait 100\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'wait')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [
        // The runner numbers its entries 1 and 2. These name other positions, and one reports a step
        // the caller cannot see as done.
        { step: 7, command: 'wait', ok: true, data: { artifacts: [script('v2', 2, id)] } },
        { step: 2, command: 'wait', ok: false, data: { artifacts: [] } },
      ],
    },
  );

  expectDeliveredNothing(response);
  expect(records(stateDir)).toHaveLength(1);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

test('a batch request that submitted no plan delivers nothing from its step entries', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v2: 'open Demo\nwait 100\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(baseUrl, stateDir, request('batch'), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'close', { scriptPublicationId: id, artifacts: [script('v2', 2, id)] })],
  });

  expectDeliveredNothing(response);
  expect(records(stateDir)).toHaveLength(1);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

test('one batch answer asks for ONE download, whatever versions it names', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const bodies: Record<string, string> = {
    v1: 'open Demo\n',
    v3: 'open Demo\nwait 100\n',
    v5: 'open Demo\nwait 100\nsnapshot\n',
  };
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace('/artifacts/', '') ?? '');
    requested.push(id);
    const body = bodies[id];
    if (body === undefined) {
      res.writeHead(503).end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  // One answer names the same versions over and over, including ones older than the newest it names.
  // Every version is the whole recording, so exactly one of them is owed: the newest.
  const repeats = (artifactId: string, revision: number, times: number) =>
    Array.from({ length: times }, () => script(artifactId, revision, id));
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'snapshot')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [
        step(1, 'wait', { artifacts: [...repeats('v3', 3, 3), ...repeats('v1', 1, 2)] }),
        step(2, 'snapshot', { artifacts: [script('v3', 3, id), script('v5', 5, id)] }),
      ],
    },
  );

  expect(requested).toEqual(['v5']);
  expect(response.ok && response.data?.savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nsnapshot\n');
});

test('a batch reads at most its bound of script artifacts, whatever an answer names', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace('/artifacts/', '') ?? '');
    requested.push(id);
    res.writeHead(200, { 'content-length': Buffer.byteLength('open Demo\n') });
    res.end('open Demo\n');
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  // Ten step entries name a hundred script artifacts each, and the batch payload names a hundred more:
  // 1,100 artifacts in one answer. The scan is bounded, and the caller is owed ONE download — the newest
  // version, which the batch payload stamps after the last step and is always read first.
  const many = (from: number) =>
    Array.from({ length: 100 }, (_, i) => script(`v-${from + i}`, from + i + 1, id));
  const results = Array.from({ length: 10 }, (_, stepIndex) =>
    step(stepIndex + 1, 'wait', { artifacts: many(stepIndex * 100) }),
  );
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan(...Array(10).fill('wait'))),
    {
      total: 10,
      executed: 10,
      totalDurationMs: 1,
      scriptPublicationId: id,
      artifacts: many(1000),
      results,
    },
  );

  // Exactly one download, and it is the newest version the scan was allowed to keep.
  expect(requested).toHaveLength(1);
  expect(response.ok && response.data?.savedScript).toBe(destination);
});

test('a batch that names twenty thousand script versions still costs one bounded scan', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace('/artifacts/', '') ?? '');
    requested.push(id);
    res.writeHead(200, { 'content-length': Buffer.byteLength('open Demo\n') });
    res.end('open Demo\n');
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  // One answer names 20,000 versions of this publication, about 3 MB of JSON, in ascending order.
  // Reading it costs this client a bounded scan, not one comparison per version it already saw.
  const versions = Array.from({ length: 20_000 }, (_, i) => script(`v-${i}`, i + 1, id));
  const startedAt = Date.now();
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('wait')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'wait', { artifacts: versions })],
  });

  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(requested).toHaveLength(1);
  expect(response.ok && response.data?.savedScript).toBe(destination);
});

test('a successful batch delivers the newest version its own payload names', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v9: 'open Demo\nsnapshot\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  // The caller ran plain steps whose answers carry nothing, and the daemon stamped its newest version
  // on the batch payload itself, as it does after the last step of a recording.
  const data = {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    scriptPublicationId: id,
    artifacts: [script('v9', 9, id)],
    results: [step(1, 'snapshot', { name: 'shot' })],
  };
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('snapshot')),
    data,
  );

  expect(response.ok && response.data?.savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nsnapshot\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a successful batch retires the record for a close its own payload names', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v7: 'open Demo\nclose\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  // The plan ran `close`, and the answer names the publication on its own payload. A stale version the
  // caller's file already holds may not be re-delivered, but the record still has to be retired.
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('close')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    scriptPublicationId: id,
    artifacts: [script('v7', 7, id)],
    results: [step(1, 'close', { closed: true })],
  });

  expect(response.ok && response.data?.savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test('a malformed script publication ID is dropped and the batch still succeeds', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  // Every ID and revision an answer carries is untrusted: an object that cannot become a string, a
  // revision that is not a positive integer, and a missing artifact ID must all be dropped rather than
  // reach a record lookup, a path, or a download request.
  const malformed = (over: Record<string, unknown>) => ({
    ...script('v2', 2, id),
    ...over,
  });
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'wait', 'wait', 'wait')),
    {
      total: 4,
      executed: 4,
      totalDurationMs: 1,
      results: [
        step(1, 'wait', { artifacts: [malformed({ scriptPublicationId: { toString: null } })] }),
        step(2, 'wait', { artifacts: [malformed({ scriptRevision: '2' })] }),
        step(3, 'wait', { artifacts: [malformed({ scriptRevision: 1.5 })] }),
        step(4, 'wait', { artifacts: [malformed({ artifactId: { toString: null } })] }),
      ],
    },
  );

  expect(response.ok).toBe(true);
  expectDeliveredNothing(response);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a batch step that cannot save its version discloses it on the batch payload', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'wait')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [
        step(1, 'wait', { artifacts: [script('gone', 2, id)] }),
        step(2, 'wait', { artifacts: [script('gone', 3, id)] }),
      ],
    },
  );

  // A batch's human and machine output reads the batch's own payload, so the failure and its
  // warning have to be lifted there — a step's nested data never reaches the CLI or the MCP text.
  expect(response.ok && response.data?.scriptDeliveryFailure).toEqual(
    expect.objectContaining({
      reason: 'script_delivery_failed',
      cause: 'script_download_failed',
      publicationId: id,
    }),
  );
  const warnings = (response.ok ? response.data?.warnings : undefined) as string[] | undefined;
  expect(warnings).toHaveLength(1);
  expect(warnings?.[0]).toContain('script');
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});
