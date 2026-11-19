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

test('retrying the interrupted version itself settles it and reports the destination', async () => {
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

  expect(retried).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(retried.ok && retried.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(path.join(directory, 'journey.ad'), 'utf8')).toBe('v1\n');

  // The settled version is now the committed one, so a further repeat is answered from the record.
  const repeated = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });
  expect(repeated).toMatchObject({ ok: true, data: { savedScript: destination } });
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
  // The first commit reports the entry it created; a repeat reports the destination as the caller spelled it.
  expect(response).toMatchObject({ ok: true, data: { savedScript: entry } });
  expect(again).toMatchObject({
    ok: true,
    data: {
      savedScript: destination,
      warnings: [
        `Revision 1 of the recording was already saved to ${destination}. It is not checked again. If that file is missing, the next recorded action writes the recording to the destination again.`,
      ],
    },
  });
  expect(again.ok && again.data).not.toHaveProperty('scriptDeliveryFailure');
});

/**
 * Records every `fs` call, synchronous or through `fs.promises`, that names a path under `root`, and restores
 * the spies at test end.
 */
function spyOnPathsUnder(root: string): () => string[] {
  const touched: string[] = [];
  const spyOn = (owner: object, label: string, methods: readonly string[]) => {
    const target = owner as Record<string, (...args: unknown[]) => unknown>;
    for (const method of methods) {
      const original = target[method]!.bind(owner);
      const spy = vi.spyOn(target, method).mockImplementation((...args: unknown[]) => {
        if (String(args[0]).startsWith(root)) touched.push(`${label}${method} ${String(args[0])}`);
        return original(...args);
      });
      onTestFinished(() => spy.mockRestore());
    }
  };
  const operations = [
    'access',
    'link',
    'lstat',
    'mkdir',
    'mkdtemp',
    'open',
    'readFile',
    'readdir',
    'realpath',
    'rename',
    'rm',
    'stat',
    'writeFile',
  ];
  spyOn(fs, '', [...operations.map((name) => `${name}Sync`), 'existsSync']);
  spyOn(fs.promises, 'promises.', operations);
  return () => touched;
}

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
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 2 });
  expect(soleRecord(stateDir).record).not.toHaveProperty('committedDigest');
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

/** Fails the record write that records a committed revision, leaving the version interrupted mid-commit. */
function interruptNextCommit(): void {
  let writes = 0;
  vi.mocked(file.publishFileSync).mockImplementation((options) => {
    // Record writes of one version: listing the staging directory, naming the version, its revision.
    if (options.destination.endsWith('.json') && writes++ === 2) throw new Error('crashed');
    actual.publishFileSync(options);
  });
}

test('re-offering a version an interrupted commit already put in place needs no download', async () => {
  // Version 2 renamed into place, and its revision was never recorded. The daemon offers it again after its
  // artifact expired: settling the interrupted commit answers it from the record, and nothing is fetched.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  interruptNextCommit();
  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] });
  vi.mocked(file.publishFileSync).mockImplementation(actual.publishFileSync);
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 1, publishing: { revision: 2 } });
  let fetches = 0;
  Object.defineProperty(served, 'v2', {
    enumerable: true,
    get: () => {
      fetches += 1;
      return undefined;
    },
  });

  const reoffered = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(fetches).toBe(0);
  expect(reoffered).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(reoffered.ok && reoffered.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 2 });
  expect(soleRecord(stateDir).record).not.toHaveProperty('publishing');
});

test('a record carrying an edited entry still answers a repeat with its destination', async () => {
  // An entry naming a same-name file elsewhere is ignored: a repeat reports the destination as the caller spelled
  // it, and a newer version is written to the destination host-kit authorizes.
  const { root, stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const unrelated = path.join(root, 'unrelated', 'journey.ad');
  fs.mkdirSync(path.dirname(unrelated));
  fs.writeFileSync(unrelated, 'unrelated\n');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file: recordFile, record } = soleRecord(stateDir);
  fs.writeFileSync(
    recordFile,
    JSON.stringify({ ...record, entry: { revision: 1, path: unrelated } }),
  );

  const repeated = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });
  const next = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(repeated).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(next).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated\n');
  expect(soleRecord(stateDir).record).not.toHaveProperty('entry');
});

test('a staging removal that fails after settlement recorded the commit keeps the committed answer', async () => {
  // A dropped Windows share answers ECONNRESET to the removal; the revision is already recorded by then.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' }, v2: { body: 'v2\n' } };
  const baseUrl = await artifactServer(served);
  const { id } = await open(baseUrl, stateDir, destination);
  interruptNextCommit();
  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] });
  vi.mocked(file.publishFileSync).mockImplementation(actual.publishFileSync);
  delete served.v2;
  const { staging } = soleRecord(stateDir).record.publishing;
  const remove = fs.rmSync.bind(fs) as (...args: unknown[]) => void;
  const reset = Object.assign(new Error('The share connection dropped'), { code: 'ECONNRESET' });
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((...args: unknown[]) => {
    if (args[0] === staging) throw reset;
    remove(...args);
  }) as typeof fs.rmSync);
  onTestFinished(() => spy.mockRestore());

  const reoffered = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(spy).toHaveBeenCalledWith(staging, { recursive: true, force: true });
  expect(reoffered).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(reoffered.ok && reoffered.data).not.toHaveProperty('scriptDeliveryFailure');
  // The directory stays listed, so retirement or the sweep removes it later.
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 2, staging: [staging] });
  expect(soleRecord(stateDir).record).not.toHaveProperty('publishing');
});

test.skipIf(process.platform === 'win32').each([
  {
    name: 'grows past the delivery cap',
    change: (staged: string) => fs.truncateSync(staged, 8 * 1024 * 1024 + 1),
  },
  {
    name: 'is swapped for a symbolic link',
    change: (staged: string) => {
      const elsewhere = `${path.dirname(path.dirname(staged))}/elsewhere.ad`;
      fs.writeFileSync(elsewhere, 'elsewhere\n');
      fs.rmSync(staged);
      fs.symlinkSync(elsewhere, staged);
    },
  },
])('a staged script that $name after its download is not committed', async ({ change }) => {
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  vi.mocked(file.confirmScriptDestination).mockImplementationOnce((spelled, prepared) => {
    const [staging] = fs
      .readdirSync(prepared.directory)
      .filter((name) => name.startsWith('.agent-device-script-'));
    change(path.join(prepared.directory, staging!, 'script.ad'));
    return actual.confirmScriptDestination(spelled, prepared);
  });

  const { response } = await open(baseUrl, stateDir, destination);

  expect(response).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_download_failed' } },
  });
  expect(fs.existsSync(destination)).toBe(false);
  expect(soleRecord(stateDir).record).toMatchObject({ revision: 0, staging: [] });
  expect(soleRecord(stateDir).record).not.toHaveProperty('publishing');
});

test('a superseded version names the revision the record last confirmed and an interrupted newer save', async () => {
  // Revision 2 is confirmed; a revision 3 save replaced the file and stopped before its commit was recorded.
  const { stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file: recordFile, record } = soleRecord(stateDir);
  const publishing = {
    revision: 3,
    file: '0:0',
    staging: path.join(directory, '.agent-device-script-3'),
  };
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, revision: 2, publishing }));

  const late = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(late).toMatchObject({
    ok: true,
    data: {
      savedScript: destination,
      warnings: [
        `Revision 1 of the recording is superseded: the record last confirmed revision 2 at ${destination}. Revision 3 may already have replaced that file; its save was interrupted. It is not checked again. If that file is missing, the next recorded action writes the recording to the destination again.`,
      ],
    },
  });
});
