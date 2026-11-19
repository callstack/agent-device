// Another delivery of the same recording commits while this one downloads or cleans up: a failed fetch is
// answered from the record under the lock, never against a stale read (ADR 0016).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
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
    confirmScriptDestination: vi.fn(actual.confirmScriptDestination),
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

/** Another delivery commits `revision`: its file renamed into place and its revision recorded. */
function otherDeliveryCommits(stateDir: string, destination: string, revision = 2): void {
  fs.writeFileSync(destination, `v${revision}\n`);
  const { file: recordFile, record } = soleRecord(stateDir);
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, revision }));
}

/** Serves version 1, and counts every fetch of version 2, running `onFetch` first and serving what it returns. */
function countedServer(onFetch: () => { body: string } | undefined = () => ({ body: 'v2\n' })) {
  const fetches = { count: 0 };
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' } };
  Object.defineProperty(served, 'v2', {
    enumerable: true,
    get: () => {
      fetches.count += 1;
      return onFetch();
    },
  });
  return { served, fetches };
}

test('a commit that lands after the unlocked first read is answered under the lock without a fetch', async () => {
  // The snapshot read outside the lock still says revision 1; the decision under the lock sees revision 2.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const { served, fetches } = countedServer();
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  const { file: recordFile } = soleRecord(stateDir);
  const read = fs.readFileSync.bind(fs) as (...args: unknown[]) => string | Buffer;
  let landed = false;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
    const contents = read(...args);
    if (!landed && args[0] === recordFile) {
      landed = true;
      otherDeliveryCommits(stateDir, destination);
    }
    return contents;
  }) as typeof fs.readFileSync);
  onTestFinished(() => spy.mockRestore());

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(landed).toBe(true);
  expect(fetches.count).toBe(0);
  expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 2, staging: [] });
});

test('a failed fetch settles a commit another delivery installed and did not record', async () => {
  // While this client fetches version 2, another delivery renames version 2 into place and stops before
  // recording it; then this fetch fails.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const { served, fetches } = countedServer(() => {
    fs.writeFileSync(destination, 'v2\n');
    const stat = fs.statSync(destination, { bigint: true });
    const { file: recordFile, record } = soleRecord(stateDir);
    const staging = path.join(directory, '.agent-device-script-other');
    const publishing = { revision: 2, file: `${stat.dev}:${stat.ino}`, staging };
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, publishing }));
    return undefined;
  });
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(fetches.count).toBe(1);
  expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 2, staging: [] });
  expect(soleRecord(stateDir).record).not.toHaveProperty('publishing');
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
  const { file: recordFile } = soleRecord(stateDir);
  // Numbers each record-lock acquisition, so the cleanup and the reread that decides can be placed in one.
  let acquisitions = 0;
  let active: number | undefined;
  vi.mocked(file.withProcessLock).mockImplementation((options) =>
    actual.withProcessLock({
      ...options,
      task: async () => {
        active = ++acquisitions;
        try {
          return await options.task();
        } finally {
          active = undefined;
        }
      },
    }),
  );
  let cleanup: number | undefined;
  const rereads: Array<number | undefined> = [];
  const rm = fs.rmSync.bind(fs) as (...args: unknown[]) => void;
  const read = fs.readFileSync.bind(fs) as (...args: unknown[]) => string | Buffer;
  const spies = [
    vi.spyOn(fs, 'rmSync').mockImplementation(((...args: unknown[]) => {
      if (
        cleanup === undefined &&
        path.basename(String(args[0])).startsWith('.agent-device-script-')
      ) {
        otherDeliveryCommits(stateDir, destination);
        cleanup = active;
      }
      rm(...args);
    }) as typeof fs.rmSync),
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      if (cleanup !== undefined && args[0] === recordFile) rereads.push(active);
      return read(...args);
    }) as typeof fs.readFileSync),
  ];

  try {
    const late = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v2', 2, id)],
    });

    expect(cleanup).toBeDefined();
    // The staging release and the decision both reread the record, inside the cleanup's own acquisition.
    expect(rereads).toEqual([cleanup, cleanup]);
    expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
    expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test('a held download that loses to a newer commit reports it superseded and overwrites nothing', async () => {
  // Version 3 is committed by another delivery while this client still holds the download of version 2.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' } };
  Object.defineProperty(served, 'v2', {
    enumerable: true,
    get: () => {
      otherDeliveryCommits(stateDir, destination, 3);
      return { body: 'v2\n' };
    },
  });
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  vi.mocked(file.confirmScriptDestination).mockClear();

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  // Answered from the record before the destination is walked again.
  expect(file.confirmScriptDestination).not.toHaveBeenCalled();

  expect(late).toMatchObject({
    ok: true,
    data: {
      savedScript: destination,
      warnings: [
        `Revision 2 of the recording is superseded: the record last confirmed revision 3 at ${destination}. It is not checked again. If that file is missing, the next recorded action writes the recording to the destination again.`,
      ],
    },
  });
  expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(destination, 'utf8')).toBe('v3\n');
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 3, staging: [] });
  expect(fs.readdirSync(directory)).toEqual(['journey.ad']);
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

test('a failed fetch after a concurrent close retired the record reports the fetch failure', async () => {
  // While this client fetches version 2, a close elsewhere retires the publication; then this fetch fails.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const { served } = countedServer(() => {
    fs.rmSync(soleRecord(stateDir).file);
    return undefined;
  });
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(late).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_download_failed' } },
  });
  expect(late.ok && late.data).not.toHaveProperty('savedScript');
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a commit that lands after the first record lock never lets an unusable parent refuse a committed version',
  async () => {
    // Another delivery commits version 2 as soon as this client's first record lock releases, and the parent then
    // becomes shared. The repeat decision, preparation and staging share that one lock, so the commit is answered
    // from the record and the shared parent is never judged for a version it already holds.
    const { stateDir, directory } = caller();
    const destination = path.join(directory, 'journey.ad');
    const { served } = countedServer();
    const baseUrl = await artifactServer(served);
    const { id } = await open(baseUrl, stateDir, destination);
    let landed = false;
    vi.mocked(file.withProcessLock).mockImplementationOnce(async (options) => {
      const result = await actual.withProcessLock(options);
      otherDeliveryCommits(stateDir, destination);
      fs.chmodSync(directory, 0o777);
      landed = true;
      return result;
    });

    try {
      const late = await answer(baseUrl, stateDir, request('click'), {
        artifacts: [script('v2', 2, id)],
      });

      expect(landed).toBe(true);
      expect(late.ok && late.data?.savedScript).toBe(destination);
      expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  },
);
