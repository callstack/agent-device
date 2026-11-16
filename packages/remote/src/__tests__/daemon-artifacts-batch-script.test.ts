import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  answer,
  artifactServer,
  batchPlan,
  batchSteps,
  closeArtifactServers,
  daemonFailure,
  expectDeliveredNothing,
  journey,
  open,
  payload,
  records,
  request,
  script,
  step,
} from './support/batch-script-fixtures.ts';
import { materializeRemoteBatchPartialArtifacts } from '../daemon-artifacts.ts';

afterEach(closeArtifactServers);

test('a batch delivers its newest script once and a close step retires the record', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    {
      v1: 'open Demo\n',
      v2: 'open Demo\nwait 100\n',
      v3: 'open Demo\nwait 100\nclose\n',
    },
    requested,
  );
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;
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
  expect(requested).toEqual(['v3']);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nclose\n');
  // The terminal step retired the record, so no later version of that publication writes anything.
  expect(records(stateDir)).toEqual([]);
  // The batch payload names the file, the way a single response does.
  expect(payload(response).savedScript).toBe(destination);
  // The steps are the daemon's own entries, unchanged.
  expect(batchSteps(response).map((result) => result.command)).toEqual(['wait', 'close']);
});

test('a batch script whose download fails discloses the failure and keeps the batch', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('wait')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    artifacts: [script('gone', 2, id)],
    results: [step(1, 'wait', { waited: true })],
  });

  // The step ran on the device, so the batch stands and the batch payload says the file is stale.
  expect(response.ok).toBe(true);
  expect(payload(response).scriptDeliveryFailure).toEqual(
    expect.objectContaining({
      reason: 'script_delivery_failed',
      cause: 'script_download_failed',
      publicationId: id,
    }),
  );
  // Like a single response: the failed script artifact does not stay in the list the caller reads.
  expect(payload(response).artifacts).toEqual([]);
  expect(payload(response).warnings).toEqual([expect.stringContaining('script')]);
  expect(JSON.stringify(response)).not.toContain('unavailable');
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  // The recording is not closed, so the record stays and a later version still lands.
  expect(records(stateDir)).toHaveLength(1);
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
  expect(payload(response).scriptDeliveryFailure).toEqual(
    expect.objectContaining({ cause: 'script_download_failed', publicationId: id }),
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toEqual([]);
});

test('a batch step script of another publication or of another field writes nothing', async () => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n', foreign: 'hostile\n' });
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
  // failure and nothing to download. The caller still has to stop tracking a recording it lost, and
  // it has to be told: the file is missing the terminal `close` and nothing else says so.
  const failure = daemonFailure(id, 2);
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('close')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [
      step(1, 'close', {
        scriptPublicationId: id,
        scriptDeliveryFailure: failure,
        warnings: [`${failure.message} ${failure.hint}`],
      }),
    ],
  });

  expect(records(stateDir)).toEqual([]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  // The step's daemon-side write failure reaches the batch payload, with its paired warning.
  expect(payload(response).scriptDeliveryFailure).toEqual(expect.objectContaining(failure));
  expect(payload(response).warnings).toEqual([`${failure.message} ${failure.hint}`]);
});

test('a finished step that reports a write failure is disclosed when an older version is delivered', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n', v2: 'open Demo\nwait 100\n' });
  const id = await open(baseUrl, stateDir, destination);

  // `[wait, close]`: the `wait` step published version 2, the `close` step could not write its final
  // version. The client saves what it can, and the batch result still has to carry the typed failure,
  // because the caller file lacks the terminal `close`.
  const failure = daemonFailure(id, 3);
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'close')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [
        step(1, 'wait', { artifacts: [script('v2', 2, id)] }),
        step(2, 'close', {
          scriptDeliveryFailure: failure,
          warnings: ['Capture dropped 1 frame.'],
        }),
      ],
    },
  );

  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\n');
  expect(payload(response).scriptDeliveryFailure).toEqual(expect.objectContaining(failure));
  // Only the warning paired with THAT failure rides up, never every step's warnings.
  expect(payload(response).warnings).toEqual([`${failure.message} ${failure.hint}`]);
  // The recording is closed, so the caller stops tracking it.
  expect(records(stateDir)).toEqual([]);
});

test('a step failure superseded by a newer delivered version is not disclosed', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v3: 'open Demo\nwait 100\nsnapshot\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  // The first step's write failed, then the daemon published and stamped version 3. The caller file
  // holds that newer version, so the stale step failure says nothing the caller still needs.
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'snapshot')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      scriptPublicationId: id,
      artifacts: [script('v3', 3, id)],
      results: [
        step(1, 'wait', {
          scriptDeliveryFailure: daemonFailure(id, 2),
          warnings: ['The session recorded version 2, but the daemon could not save it.'],
        }),
        step(2, 'snapshot', { name: 'shot' }),
      ],
    },
  );

  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nsnapshot\n');
  expect(payload(response).scriptDeliveryFailure).toBeUndefined();
  expect(payload(response).warnings).toBeUndefined();
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

test('a batch step named with other case or spaces still authorizes its delivery and retirement', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: 'open Demo\n',
    v2: 'open Demo\nclose\n',
  });
  const id = await open(baseUrl, stateDir, destination);

  // The daemon normalizes a step name before it runs it, and answers with that name. A caller that
  // compared its own raw text would stop matching, deliver nothing and keep a dead record.
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan(' CLOSE ')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'close', { scriptPublicationId: id, artifacts: [script('v2', 2, id)] })],
  });

  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test('one batch answer asks for ONE download, whatever versions it names', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    {
      v1: 'open Demo\n',
      v3: 'open Demo\nwait 100\n',
      v5: 'open Demo\nwait 100\nsnapshot\n',
    },
    requested,
  );
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
  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nsnapshot\n');
});

test('a batch reads at most its bound of step artifacts and keeps the newest version of the payload', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    { v1: 'open Demo\n', stamped: 'open Demo\nwait 100\n' },
    requested,
  );
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  // Ten finished steps name a hundred script artifacts each, all newer than the version the batch
  // payload itself stamps. The bounds stop this client reading them: it keeps the bounded payload
  // version, which is scanned first, and the versions past a bound are never asked for. Deleting a
  // bound would make a later step's newer version win this answer.
  const many = (from: number) =>
    Array.from({ length: 100 }, (_, i) => script(`step-${from + i}`, from + i + 1, id));
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
      artifacts: [script('stamped', 500, id)],
      results,
    },
  );

  expect(requested).toEqual(['stamped']);
  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\n');
});

test('a batch that names three hundred script versions keeps the bounded candidate and costs one download', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    { v1: 'open Demo\n', 's2-r200': 'open Demo\nwait 100\n' },
    requested,
  );
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  // Three finished steps name a hundred versions each. Each payload is read for 32 of its own
  // artifacts and the answer for 64 in all, so the scan stops at the second step and keeps revision
  // 200. The third step names revision 999 first and is never inspected, so deleting the total bound
  // would download `s3-r999`, and deleting the per-payload bound would download `s1-r64`.
  const ascending = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => script(`s1-r${from + i}`, from + i, id));
  const descending = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => script(`s2-r${to - i}`, to - i, id));
  const startedAt = Date.now();
  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'wait', 'wait')),
    {
      total: 3,
      executed: 3,
      totalDurationMs: 1,
      results: [
        step(1, 'wait', { artifacts: ascending(1, 100) }),
        step(2, 'wait', { artifacts: descending(101, 200) }),
        step(3, 'wait', { artifacts: [script('s3-r999', 999, id)] }),
      ],
    },
  );

  expect(requested).toEqual(['s2-r200']);
  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(payload(response).savedScript).toBe(destination);
});

test('a batch that names one hundred script versions in one step stops at the per-payload bound', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer({ v1: 'open Demo\n' }, requested);
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  // One payload is read for at most 32 of its own artifacts: revisions 1..32, revision 32 named last.
  const versions = Array.from({ length: 100 }, (_, i) => script(`v-${i}`, i + 1, id));
  await answer(baseUrl, stateDir, request('batch', {}, batchPlan('wait')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    results: [step(1, 'wait', { artifacts: versions })],
  });

  expect(requested).toEqual(['v-31']);
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

  expect(payload(response).savedScript).toBe(destination);
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

  // The plan ran `close`, and the answer names the publication on its own payload.
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('close')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    scriptPublicationId: id,
    artifacts: [script('v7', 7, id)],
    results: [step(1, 'close', { closed: true })],
  });

  expect(payload(response).savedScript).toBe(destination);
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
  expect(payload(response).scriptDeliveryFailure).toEqual(
    expect.objectContaining({
      reason: 'script_delivery_failed',
      cause: 'script_download_failed',
      publicationId: id,
    }),
  );
  const warnings = payload(response).warnings as string[];
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('script');
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

/**
 * A FAILED batch still discloses. The `wait` step succeeded on the device but the daemon could not save
 * its own version of the recording, and the step that followed failed the batch. The runner attaches
 * only the finished steps, and nothing is downloadable, so the one thing this client can still do is
 * answer with the fact the caller needs: the file is stale, and why. Disclosure does not wait on a
 * download or a retirement.
 */
test('a failed batch whose finished step reports a write failure still discloses it', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const failure = daemonFailure(id, 2);
  const details = {
    step: 2,
    command: 'snapshot',
    executed: 1,
    total: 2,
    partialResults: [
      {
        step: 1,
        command: 'wait',
        ok: true,
        durationMs: 1,
        data: { scriptDeliveryFailure: failure, warnings: [`${failure.message} ${failure.hint}`] },
      },
    ],
  };

  const disclosure = await materializeRemoteBatchPartialArtifacts(
    { baseUrl, token: 't' },
    request('batch', {}, batchPlan('wait', 'snapshot')),
    details,
    stateDir,
  );

  // The caller's error keeps its own report and gains the script facts, as the successful path gives them.
  expect(disclosure).toMatchObject({
    scriptDeliveryFailure: expect.objectContaining(failure),
    warnings: [`${failure.message} ${failure.hint}`],
  });
  expect(disclosure?.step).toBe(2);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  // A batch that never closed keeps the record, so a later version still lands.
  expect(records(stateDir)).toHaveLength(1);
});

/**
 * A foreign revision must not mask the version this client is owed. The comparison runs across
 * publication IDs before ownership is checked, so another client's revision 999 wins the answer, this
 * client's own version 2 is never downloaded, its file goes stale, no failure is reported — and the
 * record is retired anyway. A version of a recording this client never armed is not a candidate.
 */
test('a step script of another recording never outranks the newest version this client is owed', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    {
      v1: 'open Demo\n',
      v2: 'open Demo\nwait 100\n',
      // Served on purpose: choosing it would publish nothing and report nothing, which is the bug.
      foreign: 'hostile\n',
    },
    requested,
  );
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'snapshot')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [
        step(1, 'wait', {
          artifacts: [script('foreign', 999, '00000000-0000-4000-8000-000000000000')],
        }),
        step(2, 'snapshot', { artifacts: [script('v2', 2, id)] }),
      ],
    },
  );

  expect(requested).toEqual(['v2']);
  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\n');
  expect(payload(response).scriptDeliveryFailure).toBeUndefined();
  expect(records(stateDir)).toHaveLength(1);
});

/**
 * A step entry's script identity needs BOTH its reserved field and its reserved type. A `screenshot`
 * entry that borrows the `savedScript` field is not a version of the recording, and letting it into the
 * candidate list would publish it over this client's own file. Replacing the candidate guard with the
 * looser "is this a script artifact" test — field OR type — makes this answer red.
 */
test('a step entry that borrows the script field under another artifact type is not a candidate', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    { v1: 'open Demo\n', v4: 'open Demo\nwait 100\nsnapshot\n' },
    requested,
  );
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('screenshot', 'snapshot')),
    {
      total: 2,
      executed: 2,
      totalDurationMs: 1,
      results: [
        // A screenshot entry, named by the field this owner reserves, at a revision nothing else reaches.
        step(1, 'screenshot', {
          artifacts: [{ ...script('shot', 900, id), artifactType: 'screenshot' }],
        }),
        step(2, 'snapshot', { artifacts: [script('v4', 4, id)] }),
      ],
    },
  );

  expect(requested).toEqual(['v4']);
  expect(payload(response).savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait 100\nsnapshot\n');
});

/**
 * The failed-batch path must not swallow a delivery problem: the caller keeps its batch error either
 * way, so a diagnostic is the only trace that the steps that finished had a script nobody delivered.
 */
test('a failed batch whose step entries cannot be read reports the delivery failure', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);
  const partialResults: unknown[] = [];
  Object.defineProperty(partialResults, 0, {
    get(): never {
      throw new Error('unreadable step entry');
    },
    enumerable: true,
    configurable: true,
  });

  const { withDiagnosticsScope, countDiagnosticEventsByPhase } =
    await import('@agent-device/host-kit/diagnostics');
  await withDiagnosticsScope({ command: 'batch' }, async () => {
    const disclosure = await materializeRemoteBatchPartialArtifacts(
      { baseUrl, token: 't' },
      request('batch', {}, batchPlan('wait', 'wait')),
      { step: 2, command: 'wait', executed: 1, partialResults },
      stateDir,
    );

    expect(disclosure).toBeUndefined();
    expect(countDiagnosticEventsByPhase(['session_script_delivery_failed'])).toBe(1);
  });
  // And the failure costs the caller nothing else: the recording and its file stand.
  expect(id).toBeTruthy();
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});
