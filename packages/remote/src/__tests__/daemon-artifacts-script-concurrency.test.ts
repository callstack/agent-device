// Another delivery of the same recording, or its close, lands while this one fetches: the decision to
// publish is made from the record as the lock holds it, never from the read before the fetch (ADR 0016).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  answer,
  artifactServer,
  open,
  records,
  request,
  script,
  soleRecord,
} from './support/script-publication-fixtures.ts';

function caller() {
  const root = fs.realpathSync(mkdtempForTestSync('script-concurrency-'));
  return { root, stateDir: path.join(root, 'state'), directory: path.join(root, 'caller') };
}

/** Serves version 1, and runs `onFetch` each time version 2 is fetched, before serving it. */
function servedWith(onFetch: () => void) {
  const fetches = { count: 0 };
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' } };
  Object.defineProperty(served, 'v2', {
    enumerable: true,
    get: () => {
      fetches.count += 1;
      onFetch();
      return { body: 'v2\n' };
    },
  });
  return { served, fetches };
}

test('a version fetched while another process saves a newer one overwrites nothing', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const { served, fetches } = servedWith(() => {
    // Another process commits version 3: its file in place and its revision recorded.
    fs.writeFileSync(destination, 'v3\n');
    const { file, record } = soleRecord(stateDir);
    fs.writeFileSync(file, JSON.stringify({ ...record, revision: 3 }));
  });
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(fetches.count).toBe(1);
  expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(late.ok && late.data).not.toHaveProperty('warnings');
  expect(fs.readFileSync(destination, 'utf8')).toBe('v3\n');
  expect(soleRecord(stateDir).record).toEqual({ destination, force: false, revision: 3 });
  expect(fs.readdirSync(directory)).toEqual(['journey.ad']);
});

test('a version fetched while a close removes the record is not saved', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const { served, fetches } = servedWith(() => fs.rmSync(soleRecord(stateDir).file));
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(fetches.count).toBe(1);
  expect(late).toEqual({ ok: true, data: { artifacts: [] } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
  expect(records(stateDir)).toEqual([]);
});
