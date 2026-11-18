// The remote commit creates the entry host-kit authorized, and never spells one of its own from the record's
// destination (ADR 0016): the name a publisher creates is decided in one place, and an interrupted commit is
// settled from that same entry.
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
    publishFileSync: vi.fn(actual.publishFileSync),
  };
});

const actual = await vi.importActual<typeof import('@agent-device/host-kit/file')>(
  '@agent-device/host-kit/file',
);

afterEach(() => {
  vi.mocked(file.confirmScriptDestination).mockImplementation(actual.confirmScriptDestination);
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
