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

  expect(next).toMatchObject({ ok: true });
  expect(next.ok && next.data).not.toHaveProperty('scriptDeliveryFailure');
  expect(fs.readFileSync(path.join(directory, 'journey.ad'), 'utf8')).toBe('v2\n');
  expect(fs.readdirSync(directory)).toEqual(['journey.ad']);
});
