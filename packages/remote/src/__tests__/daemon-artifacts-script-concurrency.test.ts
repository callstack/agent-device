// Another delivery of the same recording commits while this one downloads or cleans up: a failed fetch is
// answered from the record under the lock, never against a stale read (ADR 0016).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as file from '@agent-device/host-kit/file';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  answer,
  artifactServer,
  open,
  request,
  script,
  soleRecord,
} from './support/script-publication-fixtures.ts';

vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return {
    ...actual,
    prepareScriptDestination: vi.fn(actual.prepareScriptDestination),
    withProcessLock: vi.fn(actual.withProcessLock),
  };
});

const actual = await vi.importActual<typeof import('@agent-device/host-kit/file')>(
  '@agent-device/host-kit/file',
);

afterEach(() => {
  vi.mocked(file.prepareScriptDestination).mockImplementation(actual.prepareScriptDestination);
  vi.mocked(file.withProcessLock).mockImplementation(actual.withProcessLock);
});

function caller() {
  const root = fs.realpathSync(mkdtempForTestSync('script-concurrency-'));
  return { root, stateDir: path.join(root, 'state'), directory: path.join(root, 'caller') };
}

/** Another delivery commits version 2: its file renamed into place and its revision recorded. */
function otherDeliveryCommits(stateDir: string, destination: string): void {
  fs.writeFileSync(destination, 'v2\n');
  const { file: recordFile, record } = soleRecord(stateDir);
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, revision: 2, entry: destination }));
}

test('a failed download after another delivery commits the same version reports the file', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  delete served.v2;
  vi.mocked(file.prepareScriptDestination).mockImplementationOnce((spelled) => {
    otherDeliveryCommits(stateDir, destination);
    return actual.prepareScriptDestination(spelled);
  });

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
});

test('a commit that lands while a failed download cleans up its staging is still reported', async () => {
  // The fetch fails; another delivery commits version 2 as this client removes its staging. The decision is
  // made after the cleanup, in the same lock, so it sees that commit.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  delete served.v2;
  const rm = fs.rmSync.bind(fs) as (...args: unknown[]) => void;
  let landed = false;
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((...args: unknown[]) => {
    const target = String(args[0]);
    if (!landed && path.basename(target).startsWith('.agent-device-script-')) {
      landed = true;
      otherDeliveryCommits(stateDir, destination);
    }
    rm(...args);
  }) as typeof fs.rmSync);

  try {
    const late = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v2', 2, id)],
    });

    expect(landed).toBe(true);
    expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
    expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  } finally {
    spy.mockRestore();
  }
});

test('a transient failure acquiring the final record lock still releases staging', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  delete served.v2;
  let failedAcquisition = false;
  vi.mocked(file.withProcessLock).mockImplementation((options) =>
    actual.withProcessLock({
      ...options,
      acquire: async () => {
        if (!failedAcquisition && soleRecord(stateDir).record.staging?.length) {
          failedAcquisition = true;
          throw new Error('Transient record lock acquisition failure');
        }
        return await options.acquire();
      },
    }),
  );

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(failedAcquisition).toBe(true);
  expect(late.ok && late.data).toHaveProperty('scriptDeliveryFailure');
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 1, staging: [] });
  expect(fs.readdirSync(directory)).toEqual(['journey.ad']);
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
});
