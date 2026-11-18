// The remote commit creates the entry host-kit authorized, and never spells one of its own from the record's
// destination (ADR 0016): the name a publisher creates is decided in one place, and an interrupted commit is
// settled from that same entry.
import { execFileSync } from 'node:child_process';
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
  return {
    ...actual,
    confirmScriptDestination: vi.fn(actual.confirmScriptDestination),
    prepareScriptDestination: vi.fn(actual.prepareScriptDestination),
    publishFileSync: vi.fn(actual.publishFileSync),
  };
});

const actual = await vi.importActual<typeof import('@agent-device/host-kit/file')>(
  '@agent-device/host-kit/file',
);

afterEach(() => {
  vi.mocked(file.confirmScriptDestination).mockImplementation(actual.confirmScriptDestination);
  vi.mocked(file.prepareScriptDestination).mockImplementation(actual.prepareScriptDestination);
  vi.mocked(file.publishFileSync).mockImplementation(actual.publishFileSync);
});

function caller() {
  const root = fs.realpathSync(mkdtempForTestSync('script-entry-'));
  return { root, stateDir: path.join(root, 'state'), directory: path.join(root, 'caller') };
}

test('the remote commit creates the entry the confirmation authorized', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const authorized = path.join(directory, 'authorized.ad');
  const confirm = vi.mocked(file.confirmScriptDestination);
  // A distinct name, so an entry spelled from the record's destination lands somewhere this one does not.
  confirm.mockImplementation((spelled, prepared) => ({
    ...actual.confirmScriptDestination(spelled, prepared),
    name: 'authorized.ad',
    entry: authorized,
  }));
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

  await open(baseUrl, stateDir, destination);

  expect(confirm).toHaveBeenCalledWith(destination, expect.anything());
  expect(fs.readFileSync(authorized, 'utf8')).toBe('open Demo\n');
  expect(fs.existsSync(destination)).toBe(false);
});

test('an interrupted commit spelled with a trailing separator is settled from the entry it created', async () => {
  // A crash after the rename and before the revision is recorded leaves the record naming the version. The
  // destination is spelled `journey.ad/`, which the filesystem refuses to look up once `journey.ad` is a file.
  const { stateDir, directory } = caller();
  const destination = `${path.join(directory, 'journey.ad')}/`;
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  let writes = 0;
  vi.mocked(file.publishFileSync).mockImplementation((options) => {
    // Record writes: the record itself, listing the staging directory, naming the version, its revision.
    if (options.destination.endsWith('.json') && writes++ === 3) throw new Error('crashed');
    actual.publishFileSync(options);
  });
  const { id } = await open(baseUrl, stateDir, destination);
  vi.mocked(file.publishFileSync).mockImplementation(actual.publishFileSync);

  const next = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  // The path reported is the file written, without the separator the spelling carried.
  expect(next).toMatchObject({
    ok: true,
    data: { savedScript: path.join(directory, 'journey.ad') },
  });
  expect(next.ok && next.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(path.join(directory, 'journey.ad'), 'utf8')).toBe('v2\n');
  expect(fs.readdirSync(directory)).toEqual(['journey.ad']);
});

/** The single record this client keeps for the open, and its parsed contents. */
function soleRecord(stateDir: string) {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  const [name] = fs.readdirSync(directory).filter((entry) => entry.endsWith('.json'));
  const file = path.join(directory, name as string);
  return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a record naming an unrelated file cannot pass that file off as the interrupted version', async () => {
  const { root, stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  fs.rmSync(destination);
  const unrelated = path.join(root, 'unrelated.ad');
  fs.writeFileSync(unrelated, 'unrelated\n');
  const stat = fs.statSync(unrelated, { bigint: true });
  const { file, record } = soleRecord(stateDir);
  const staging = path.join(directory, '.agent-device-script-tampered');
  const publishing = { revision: 9, file: `${stat.dev}:${stat.ino}`, staging, entry: unrelated };
  fs.writeFileSync(file, JSON.stringify({ ...record, publishing }));

  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] });

  // Version 2 is newer than anything committed to the destination, so it is written there.
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated\n');
});

test('a record whose interrupted version is null is no record, and the response keeps its outcome', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file, record } = soleRecord(stateDir);
  fs.writeFileSync(file, JSON.stringify({ ...record, publishing: null }));

  await expect(
    answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] }),
  ).resolves.toMatchObject({ ok: true });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
});

type Delivery = Readonly<{ saved: true } | { saved: false; cause: string }>;

const ENTRY_CASES: ReadonlyArray<{
  name: string;
  force: boolean;
  delivery: Delivery;
  arrange: (directory: string) => string;
  verify: (directory: string, destination: string) => void;
}> = [false, true].flatMap((force) => [
  {
    name: 'an overlong name',
    force,
    delivery: { saved: false, cause: 'script_ancestor_untrusted' },
    arrange: (directory: string) => path.join(directory, 'new', 'a'.repeat(256)),
    verify: (directory: string) => expect(fs.existsSync(path.join(directory, 'new'))).toBe(false),
  },
  {
    name: 'a directory at the entry',
    force,
    delivery: { saved: false, cause: force ? 'script_download_failed' : 'script_target_exists' },
    arrange: (directory: string) => {
      const destination = path.join(directory, 'journey.ad');
      fs.mkdirSync(destination, { recursive: true });
      return destination;
    },
    verify: (_directory: string, destination: string) => {
      expect(fs.lstatSync(destination).isDirectory()).toBe(true);
      expect(fs.readdirSync(destination)).toEqual([]);
    },
  },
  {
    name: 'a hard link at the entry',
    force,
    delivery: force ? { saved: true } : { saved: false, cause: 'script_target_exists' },
    arrange: (directory: string) => {
      fs.mkdirSync(directory, { recursive: true });
      const destination = path.join(directory, 'journey.ad');
      fs.writeFileSync(path.join(directory, 'theirs.ad'), 'theirs\n');
      fs.linkSync(path.join(directory, 'theirs.ad'), destination);
      return destination;
    },
    verify: (directory: string, destination: string) => {
      // Replaced as a directory entry, never written through to the file it shared.
      expect(fs.readFileSync(path.join(directory, 'theirs.ad'), 'utf8')).toBe('theirs\n');
      expect(fs.readFileSync(destination, 'utf8')).toBe(force ? 'v1\n' : 'theirs\n');
    },
  },
]);

test.skipIf(process.platform === 'win32').each(ENTRY_CASES)(
  'a remote recording to $name with force=$force',
  async ({ force, delivery, arrange, verify }) => {
    const { stateDir, directory } = caller();
    const destination = arrange(directory);
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });

    const { response } = await open(baseUrl, stateDir, destination, { force });

    if (delivery.saved) {
      expect(response).toMatchObject({ ok: true, data: { savedScript: destination } });
    } else {
      expect(response).toMatchObject({
        ok: true,
        data: { scriptDeliveryFailure: { cause: delivery.cause } },
      });
    }
    verify(directory, destination);
  },
);

test('retrying the interrupted version itself reports the entry it settled', async () => {
  const { stateDir, directory } = caller();
  const destination = `${path.join(directory, 'journey.ad')}/`;
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  let writes = 0;
  vi.mocked(file.publishFileSync).mockImplementation((options) => {
    // The fourth record write records the revision; failing it leaves version 1 committed but unrecorded.
    if (options.destination.endsWith('.json') && writes++ === 3) throw new Error('crashed');
    actual.publishFileSync(options);
  });
  const { id } = await open(baseUrl, stateDir, destination);
  vi.mocked(file.publishFileSync).mockImplementation(actual.publishFileSync);

  const retried = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(retried).toMatchObject({
    ok: true,
    data: { savedScript: path.join(directory, 'journey.ad') },
  });
  expect(retried.ok && retried.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(path.join(directory, 'journey.ad'), 'utf8')).toBe('v1\n');

  // The settled version is now the committed one, so a further repeat still reports it.
  const repeated = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });
  expect(repeated).toMatchObject({
    ok: true,
    data: { savedScript: path.join(directory, 'journey.ad') },
  });
  expect(repeated.ok && repeated.data).not.toHaveProperty('scriptDeliveryFailure');
});

test('a version delivered twice reports the committed entry both times', async () => {
  const { stateDir, directory } = caller();
  const destination = `${path.join(directory, 'journey.ad')}/`;
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const entry = path.join(directory, 'journey.ad');

  const { id, response } = await open(baseUrl, stateDir, destination);
  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(response).toMatchObject({ ok: true, data: { savedScript: entry } });
  expect(again).toMatchObject({ ok: true, data: { savedScript: entry } });
  expect(fs.readFileSync(entry, 'utf8')).toBe('v1\n');
});

/** Runs `task` with the Windows branch of host-kit's destination rule, where no walk runs. */
async function onWindowsRules<T>(task: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return await task();
  } finally {
    Object.defineProperty(process, 'platform', original!);
  }
}

test.each([
  { rules: 'native', within: <T>(task: () => Promise<T>) => task() },
  { rules: 'Windows', within: onWindowsRules },
])(
  'a version delivered again after its file was deleted discloses the change ($rules rules)',
  async ({ within }) => {
    const { stateDir, directory } = caller();
    const destination = path.join(directory, 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
    const { id } = await open(baseUrl, stateDir, destination);
    fs.rmSync(destination);

    const again = await within(() =>
      answer(baseUrl, stateDir, request('click'), { artifacts: [script('v1', 1, id)] }),
    );

    expect(again).toMatchObject({
      ok: true,
      data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
    });
    expect(again.ok && again.data?.savedScript).not.toBe(destination);
    expect(fs.existsSync(destination)).toBe(false);
  },
);

test.skipIf(process.platform === 'win32')(
  'a version delivered again through a retargeted link never reports the unrelated file there',
  async () => {
    const { stateDir, directory } = caller();
    const first = path.join(directory, 'first');
    const second = path.join(directory, 'second');
    fs.mkdirSync(first, { recursive: true, mode: 0o700 });
    fs.mkdirSync(second, { mode: 0o700 });
    const alias = path.join(directory, 'alias');
    fs.symlinkSync(first, alias);
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
    const { id } = await open(baseUrl, stateDir, path.join(alias, 'journey.ad'));
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias);
    fs.writeFileSync(path.join(second, 'journey.ad'), 'unrelated\n');

    const again = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v1', 1, id)],
    });

    expect(again).toMatchObject({
      ok: true,
      data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
    });
    expect(again.ok && again.data?.savedScript).not.toBe(path.join(second, 'journey.ad'));
    expect(fs.readFileSync(path.join(first, 'journey.ad'), 'utf8')).toBe('v1\n');
    expect(fs.readFileSync(path.join(second, 'journey.ad'), 'utf8')).toBe('unrelated\n');
  },
);

test('a record from an earlier release answers a repeated version as unverifiable', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file, record } = soleRecord(stateDir);
  const { committedDigest: _digest, ...older } = record;
  fs.writeFileSync(file, JSON.stringify(older));

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  // Nothing says the file moved: the client only cannot vouch for it.
  expect(again).toMatchObject({
    ok: true,
    data: {
      scriptDeliveryFailure: {
        cause: 'script_entry_unverified',
        message: expect.stringMatching(/could not be verified/),
      },
    },
  });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
});

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('a copy that became a repeat while it downloaded is checked like an early repeat', async () => {
  // Another copy of version 2 commits while this one downloads, and the file is then replaced; the late copy
  // reaches the locked commit with its revision already published.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  // Past this copy's early repeat check and before its locked commit: the other copy lands, then the file is
  // replaced.
  vi.mocked(file.prepareScriptDestination).mockImplementationOnce((spelled) => {
    const { file: recordFile, record } = soleRecord(stateDir);
    fs.writeFileSync(
      recordFile,
      JSON.stringify({ ...record, revision: 2, committedDigest: sha256('v2\n') }),
    );
    fs.writeFileSync(destination, 'unrelated\n');
    return actual.prepareScriptDestination(spelled);
  });

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(late).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
  });
  expect(late.ok && late.data?.savedScript).not.toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('unrelated\n');
});

test.skipIf(process.platform === 'win32').each([
  { name: 'different bytes', bytes: 'replaced\n', saved: false },
  { name: 'the committed bytes', bytes: 'v1\n', saved: true },
])('a repeat after the file was replaced at the same path with $name', async ({ bytes, saved }) => {
  // A replacement can inherit the deleted file's inode, so only its content says whether it is the version.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  fs.rmSync(destination);
  fs.writeFileSync(destination, bytes);

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  if (saved) {
    expect(again).toMatchObject({ ok: true, data: { savedScript: destination } });
    expect(again.ok && again.data).not.toHaveProperty('scriptDeliveryFailure');
  } else {
    expect(again).toMatchObject({
      ok: true,
      data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
    });
  }
  expect(fs.readFileSync(destination, 'utf8')).toBe(bytes);
});

test('a repeat after its output directory was removed says the saved file is gone', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'out', 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  fs.rmSync(path.join(directory, 'out'), { recursive: true });

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(again).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
  });
  expect(fs.existsSync(path.join(directory, 'out'))).toBe(false);
});

test('a repeat whose file was overwritten in place, keeping its inode, discloses the change', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const inode = fs.statSync(destination).ino;
  fs.writeFileSync(destination, 'v9\n');
  expect(fs.statSync(destination).ino).toBe(inode);

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(again).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
  });
});

test.skipIf(process.platform === 'win32')(
  'a repeat whose file is swapped for a symbolic link after it was looked at discloses the change',
  async () => {
    const { root, stateDir, directory } = caller();
    const destination = path.join(directory, 'journey.ad');
    const elsewhere = path.join(root, 'elsewhere.ad');
    fs.writeFileSync(elsewhere, 'v1\n');
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
    const { id } = await open(baseUrl, stateDir, destination);
    const lstat = fs.lstatSync.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((
      target: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      const seen = lstat(target, options);
      if (!swapped && target === destination) {
        // Between the look and the open: a link to a file holding the very bytes committed takes the name.
        swapped = true;
        fs.rmSync(destination);
        fs.symlinkSync(elsewhere, destination);
      }
      return seen;
    }) as typeof fs.lstatSync);

    try {
      const again = await answer(baseUrl, stateDir, request('click'), {
        artifacts: [script('v1', 1, id)],
      });

      expect(swapped).toBe(true);
      expect(again).toMatchObject({
        ok: true,
        data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
      });
    } finally {
      spy.mockRestore();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'a repeat whose file was replaced by a FIFO discloses the change without opening it',
  async () => {
    const { stateDir, directory } = caller();
    const destination = path.join(directory, 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
    const { id } = await open(baseUrl, stateDir, destination);
    fs.rmSync(destination);
    execFileSync('mkfifo', [destination]);

    const again = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v1', 1, id)],
    });

    expect(again).toMatchObject({
      ok: true,
      data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
    });
  },
);

test.each([
  { name: 'a few bytes', grow: 'extra\n'.length },
  { name: 'past the delivery cap', grow: 9 * 1024 * 1024 },
])('a repeat whose file grows by $name while it is read discloses the change', async ({ grow }) => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const read = fs.readSync.bind(fs) as (...args: unknown[]) => number;
  let grown = false;
  let digestBytes = 0;
  const spy = vi.spyOn(fs, 'readSync').mockImplementation(((...args: unknown[]) => {
    // Only the digest's own chunked reads: a 64 KiB buffer read from the current position.
    const chunked = (args[1] as Buffer | undefined)?.length === 64 * 1024 && args[4] === null;
    if (chunked && !grown) {
      grown = true;
      fs.appendFileSync(destination, Buffer.alloc(grow, 0x61));
    }
    const count = read(...args);
    if (chunked) digestBytes += count;
    return count;
  }) as typeof fs.readSync);

  try {
    const again = await answer(baseUrl, stateDir, request('click'), {
      artifacts: [script('v1', 1, id)],
    });

    expect(grown).toBe(true);
    expect(again).toMatchObject({
      ok: true,
      data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
    });
    // The read stops at the cap instead of following the file wherever it grows.
    expect(digestBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 64 * 1024);
  } finally {
    spy.mockRestore();
  }
});

test('a copy that became a repeat while its output directory was removed says the file is gone', async () => {
  const { stateDir, directory } = caller();
  const output = path.join(directory, 'out');
  const destination = path.join(output, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  vi.mocked(file.prepareScriptDestination).mockImplementationOnce((spelled) => {
    // Another copy of version 2 lands while this one is in flight.
    const { file: recordFile, record } = soleRecord(stateDir);
    fs.writeFileSync(
      recordFile,
      JSON.stringify({ ...record, revision: 2, committedDigest: sha256('v2\n') }),
    );
    return actual.prepareScriptDestination(spelled);
  });
  vi.mocked(file.confirmScriptDestination).mockImplementationOnce((spelled, prepared) => {
    // Then the output directory goes before this copy's locked commit judges it.
    fs.rmSync(output, { recursive: true, force: true });
    return actual.confirmScriptDestination(spelled, prepared);
  });

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(late).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_entry_changed' } },
  });
  expect(fs.existsSync(output)).toBe(false);
});

test('an interrupted first save whose directory is gone says it was never confirmed', async () => {
  // The record names version 1 as being published, but no commit confirmed it, and nothing was ever saved.
  const { stateDir, directory } = caller();
  const output = path.join(directory, 'out');
  const destination = path.join(output, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination, {
    respond: (publicationId) => ({ ok: true, data: { scriptPublicationId: publicationId } }),
  });
  const { file: recordFile, record } = soleRecord(stateDir);
  fs.writeFileSync(
    recordFile,
    JSON.stringify({
      ...record,
      publishing: { revision: 1, file: '0:0', staging: path.join(directory, 'gone') },
    }),
  );
  vi.mocked(file.confirmScriptDestination).mockImplementationOnce((spelled, prepared) => {
    fs.rmSync(output, { recursive: true, force: true });
    return actual.confirmScriptDestination(spelled, prepared);
  });

  const retried = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(retried).toMatchObject({
    ok: true,
    data: {
      scriptDeliveryFailure: {
        cause: 'script_entry_changed',
        message: expect.stringMatching(/interrupted before it was confirmed/),
      },
    },
  });
  expect(retried.ok && retried.data?.scriptDeliveryFailure).not.toMatchObject({
    message: expect.stringMatching(/saved earlier/),
  });
});
