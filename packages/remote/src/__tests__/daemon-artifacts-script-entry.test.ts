// The remote commit creates the entry host-kit authorized, and never spells one of its own from the record's
// destination (ADR 0016): the name a publisher creates is decided in one place.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import * as file from '@agent-device/host-kit/file';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { artifactServer, open } from './support/script-publication-fixtures.ts';

vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return { ...actual, confirmScriptDestination: vi.fn(actual.confirmScriptDestination) };
});

test('the remote commit creates the entry the confirmation authorized', async () => {
  const root = fs.realpathSync(mkdtempForTestSync('script-entry-'));
  const destination = path.join(root, 'caller', 'journey.ad');
  const authorized = path.join(root, 'caller', 'authorized.ad');
  const confirm = vi.mocked(file.confirmScriptDestination);
  const actual = confirm.getMockImplementation()!;
  // A distinct name, so an entry spelled from the record's destination lands somewhere this one does not.
  confirm.mockImplementation((spelled, prepared) => ({
    ...actual(spelled, prepared),
    name: 'authorized.ad',
    entry: authorized,
  }));
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

  await open(baseUrl, path.join(root, 'state'), destination);

  expect(confirm).toHaveBeenCalledWith(destination, expect.anything());
  expect(fs.readFileSync(authorized, 'utf8')).toBe('open Demo\n');
  expect(fs.existsSync(destination)).toBe(false);
});
