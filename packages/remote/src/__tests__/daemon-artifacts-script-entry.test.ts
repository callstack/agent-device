// The remote commit creates the entry host-kit authorized, and never spells one of its own from the record's
// destination (ADR 0016): the name a publisher creates is decided in one place, and an interrupted commit is
// settled from that same entry.
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

test('a version delivered again is answered from the record without touching the saved file', async () => {
  const { stateDir, directory } = caller();
  const destination = `${path.join(directory, 'journey.ad')}/`;
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' } };
  const baseUrl = await artifactServer(served);
  const entry = path.join(directory, 'journey.ad');
  const { id, response } = await open(baseUrl, stateDir, destination);
  // Gone from the server and from disk: only the record can answer the repeat.
  delete served.v1;
  fs.rmSync(entry);
  const touched = spyOnPathsUnder(directory);

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(touched()).toEqual([]);
  expect(file.prepareScriptDestination).toHaveBeenCalledTimes(1);
  expect(response).toMatchObject({ ok: true, data: { savedScript: entry } });
  expect(again).toMatchObject({
    ok: true,
    data: {
      savedScript: entry,
      warnings: [
        `Revision 1 of the recording was already saved to ${entry} and is not checked again. If that file is missing, the next recorded action writes it again.`,
      ],
    },
  });
  expect(again.ok && again.data).not.toHaveProperty('scriptDeliveryFailure');
});

/** Records every synchronous `fs` call that names a path under `root`, and restores the spies at test end. */
function spyOnPathsUnder(root: string): () => string[] {
  const touched: string[] = [];
  const methods = [
    'accessSync',
    'existsSync',
    'linkSync',
    'lstatSync',
    'mkdirSync',
    'mkdtempSync',
    'openSync',
    'readFileSync',
    'readdirSync',
    'realpathSync',
    'renameSync',
    'rmSync',
    'statSync',
    'writeFileSync',
  ] as const;
  const target = fs as unknown as Record<(typeof methods)[number], (...args: unknown[]) => unknown>;
  for (const method of methods) {
    const original = target[method].bind(fs);
    const spy = vi.spyOn(target, method).mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith(root)) touched.push(`${method} ${String(args[0])}`);
      return original(...args);
    });
    onTestFinished(() => spy.mockRestore());
  }
  return () => touched;
}

test.skipIf(process.platform === 'win32')(
  'a version delivered again through a retargeted link reports the entry it was committed to',
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
      data: { savedScript: path.join(first, 'journey.ad') },
    });
    expect(fs.readFileSync(path.join(first, 'journey.ad'), 'utf8')).toBe('v1\n');
    expect(fs.readFileSync(path.join(second, 'journey.ad'), 'utf8')).toBe('unrelated\n');
  },
);

test('a record that still carries a content digest parses, and a repeat ignores the digest', async () => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file: recordFile, record } = soleRecord(stateDir);
  const digest = 'f'.repeat(64);
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, committedDigest: digest }));

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });
  const next = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(again).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(next).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 2, entry: destination });
});

test.skipIf(process.platform === 'win32')(
  'the real walk through a linked parent creates and reports the entry it judged',
  async () => {
    // No mocks: the parent is spelled through a symbolic link, and the walk's own answer is where the
    // script lands and what is reported.
    const { stateDir, directory } = caller();
    const real = path.join(directory, 'real');
    fs.mkdirSync(real, { recursive: true, mode: 0o700 });
    fs.symlinkSync(real, path.join(directory, 'linked'));
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });

    const { response } = await open(
      baseUrl,
      stateDir,
      path.join(directory, 'linked', 'journey.ad'),
    );

    expect(response).toMatchObject({
      ok: true,
      data: { savedScript: path.join(real, 'journey.ad') },
    });
    expect(fs.readFileSync(path.join(real, 'journey.ad'), 'utf8')).toBe('v1\n');
    expect(fs.lstatSync(path.join(directory, 'linked')).isSymbolicLink()).toBe(true);
  },
);

test('a version an interrupted commit never put in place is downloaded even after its directory is gone', async () => {
  // The record names version 1 as being published, but nothing reached the entry and the output directory is
  // gone: settling finds no repeat, so the download recreates the directory and publishes.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'out', 'journey.ad');
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

  const delivered = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(delivered).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
});
