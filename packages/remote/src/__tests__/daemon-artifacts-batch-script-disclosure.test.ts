import fs from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import {
  answer,
  artifactServer,
  batchPlan,
  closeArtifactServers,
  daemonFailure,
  expectDeliveredNothing,
  journey,
  open,
  records,
  request,
  script,
  step,
} from './support/batch-script-fixtures.ts';

afterEach(closeArtifactServers);

/**
 * Retirement is authorized by a validated FINISHED `close` step, never by the plan plus the counts. The
 * report here counts two finished steps of the plan `[wait, close, snapshot]`, and the plan's second
 * step IS `close`, but the entry at that position names `wait`. The caller never ran the close its plan
 * declared, so its record must stay and a later step must still be able to deliver.
 */
test('a finished count that passes the plan close entry names no close and retires nothing', async () => {
  const { stateDir, destination } = journey();
  const requested: string[] = [];
  const baseUrl = await artifactServer(
    { v1: 'open Demo\n', final: 'open Demo\nwait 100\nsnapshot\n' },
    requested,
  );
  const id = await open(baseUrl, stateDir, destination);
  requested.length = 0;

  const response = await answer(
    baseUrl,
    stateDir,
    request('batch', {}, batchPlan('wait', 'close', 'snapshot')),
    {
      total: 3,
      executed: 2,
      totalDurationMs: 1,
      // The daemon stamps the recording on its own payload, as it does for every step of a recording.
      scriptPublicationId: id,
      results: [
        step(1, 'wait', { waited: true }),
        // The plan's `close` position, answered under another command, carrying the close's own artifact.
        {
          step: 2,
          command: 'wait',
          ok: true,
          durationMs: 1,
          data: { scriptPublicationId: id, artifacts: [script('final', 2, id)] },
        },
      ],
    },
  );

  // The close nobody ran retires nothing: a later step still delivers this recording.
  expect(records(stateDir)).toHaveLength(1);
  expect(requested).toEqual([]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expectDeliveredNothing(response);
});

/**
 * Both halves of the delivery can fail at once: the daemon could not write its own version, and this
 * client could not download one either. Both facts belong in the answer, so the warnings the batch
 * payload already carried stay, and this client's own line is added beside them.
 */
test('a batch whose daemon write and client download both failed reports both warnings', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: 'open Demo\n' });
  const id = await open(baseUrl, stateDir, destination);

  const daemon = daemonFailure(id, 3);
  const response = await answer(baseUrl, stateDir, request('batch', {}, batchPlan('wait')), {
    total: 1,
    executed: 1,
    totalDurationMs: 1,
    // The daemon stamps its own failed write on the batch payload, with its warning.
    scriptDeliveryFailure: daemon,
    warnings: [`${daemon.message} ${daemon.hint}`],
    results: [step(1, 'wait', { artifacts: [script('gone', 4, id)] })],
  });

  expect(response.ok).toBe(true);
  // This client's own report about this response wins the typed field...
  expect(response.ok && response.data?.scriptDeliveryFailure).toEqual(
    expect.objectContaining({ cause: 'script_download_failed', publicationId: id }),
  );
  // ...and the daemon's write warning is still there, not replaced.
  const warnings = (response.ok && response.data?.warnings) as string[];
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toBe(`${daemon.message} ${daemon.hint}`);
  expect(warnings[1]).toContain('remote script could not be saved');
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});
