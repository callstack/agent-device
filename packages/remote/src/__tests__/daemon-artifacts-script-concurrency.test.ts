// Another delivery of the same recording lands while this one settles, downloads, or cleans up: the answer
// is decided against the record under the lock, never against a stale read (ADR 0016).
import crypto from 'node:crypto';
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
} from './support/script-publication-fixtures.ts';

vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return { ...actual, prepareScriptDestination: vi.fn(actual.prepareScriptDestination) };
});

const actual = await vi.importActual<typeof import('@agent-device/host-kit/file')>(
  '@agent-device/host-kit/file',
);

afterEach(() => {
  vi.mocked(file.prepareScriptDestination).mockImplementation(actual.prepareScriptDestination);
});

function caller() {
  const root = fs.realpathSync(mkdtempForTestSync('script-concurrency-'));
  return { root, stateDir: path.join(root, 'state'), directory: path.join(root, 'caller') };
}

/** The single record this client keeps for the open, and its parsed contents. */
function soleRecord(stateDir: string) {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  const [name] = fs.readdirSync(directory).filter((entry) => entry.endsWith('.json'));
  const file = path.join(directory, name as string);
  return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Another delivery's version 2, renamed into place; `committed` says whether it also recorded the commit. */
function otherDeliveryLands(stateDir: string, destination: string, committed: boolean): void {
  fs.writeFileSync(destination, 'v2\n');
  const stat = fs.statSync(destination, { bigint: true });
  const { file: recordFile, record } = soleRecord(stateDir);
  const next = committed
    ? { ...record, revision: 2, committedDigest: sha256('v2\n') }
    : {
        ...record,
        publishing: {
          revision: 2,
          file: `${stat.dev}:${stat.ino}`,
          staging: path.join(path.dirname(destination), '.agent-device-script-other'),
          digest: sha256('v2\n'),
        },
      };
  fs.writeFileSync(recordFile, JSON.stringify(next));
}

test('a delivery whose first read went stale settles from the record under the lock', async () => {
  // This client reads the record at revision 1; the other delivery then puts version 2 in place and stops
  // before recording it.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  // Version 2 stays served, and every fetch of it is counted: settling from the locked record answers it
  // from disk, so it is never fetched; a stale snapshot would stage and fetch it first.
  let fetches = 0;
  const v2 = { body: 'v2\n' };
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' } };
  Object.defineProperty(served, 'v2', {
    enumerable: true,
    get: () => {
      fetches += 1;
      return v2;
    },
  });
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  const { file: recordFile } = soleRecord(stateDir);
  const read = fs.readFileSync.bind(fs) as (...args: unknown[]) => string | Buffer;
  let landed = false;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
    const contents = read(...args);
    if (!landed && args[0] === recordFile) {
      landed = true;
      otherDeliveryLands(stateDir, destination, false);
    }
    return contents;
  }) as typeof fs.readFileSync);

  try {
    const late = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v2', 2, id)],
    });

    expect(landed).toBe(true);
    expect(fetches).toBe(0);
    expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
    expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
  } finally {
    spy.mockRestore();
  }
});

test.each([
  { name: 'commits', committed: true },
  { name: 'is interrupted after its rename', committed: false },
])(
  'a failed download after another delivery $name between settlement and staging reports the file',
  async ({ committed }) => {
    const { stateDir, directory } = caller();
    const destination = path.join(directory, 'journey.ad');
    const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
    const baseUrl = await artifactServer(served);
    const { id } = await open(baseUrl, stateDir, destination);
    delete served.v2;
    vi.mocked(file.prepareScriptDestination).mockImplementationOnce((spelled) => {
      otherDeliveryLands(stateDir, destination, committed);
      return actual.prepareScriptDestination(spelled);
    });

    const late = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v2', 2, id)],
    });

    expect(late).toMatchObject({ ok: true, data: { savedScript: destination } });
    expect(late.ok && late.data).not.toHaveProperty('scriptDeliveryFailure');
    expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  },
);

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
      otherDeliveryLands(stateDir, destination, true);
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

test.skipIf(process.platform === 'win32').each([
  {
    name: 'its committed file no longer verifies',
    cause: 'script_entry_changed',
    after: (destination: string) => fs.writeFileSync(destination, 'tampered\n'),
  },
  {
    name: 'its directory became shared',
    cause: 'script_ancestor_untrusted',
    after: (destination: string) => fs.chmodSync(path.dirname(destination), 0o777),
  },
])(
  'a failed download whose recheck finds the version committed but $name reports that, not the fetch',
  async ({ cause, after }) => {
    const { stateDir, directory } = caller();
    const output = path.join(directory, 'output');
    const destination = path.join(output, 'journey.ad');
    const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
    const baseUrl = await artifactServer(served);
    const { id } = await open(baseUrl, stateDir, destination);
    delete served.v2;
    vi.mocked(file.prepareScriptDestination).mockImplementationOnce((spelled) => {
      const prepared = actual.prepareScriptDestination(spelled);
      // Another delivery commits version 2 after this client settled, then the entry or its ground changes.
      otherDeliveryLands(stateDir, destination, true);
      after(destination);
      return prepared;
    });

    try {
      const late = await answer(baseUrl, stateDir, request('click'), {
        artifacts: [script('v2', 2, id)],
      });

      expect(late).toMatchObject({ ok: true, data: { scriptDeliveryFailure: { cause } } });
    } finally {
      fs.chmodSync(output, 0o700);
    }
  },
);
