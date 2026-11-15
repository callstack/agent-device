import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { prepareRemoteRequestArtifacts } from '../daemon-artifacts.ts';

const REMOTE = { baseUrl: 'http://remote.example.test', token: 'test' };
const signal = new AbortController().signal;

test('remote open separates the caller output from the daemon target', async () => {
  const root = mkdtempForTestSync('script-destination-');
  const result = await prepareRemoteRequestArtifacts(
    {
      session: 'owned',
      command: 'open',
      positionals: ['Demo'],
      flags: { saveScript: 'output.ad' },
      meta: { cwd: root },
    },
    REMOTE,
    signal,
    createTestHostEnvironment(),
  );
  expect(result.clientArtifactPaths?.savedScript).toBe(path.join(root, 'output.ad'));
  expect(result.positionals).toEqual(['Demo']);
  expect(result.flags?.saveScript).toBe(true);
});

test.each(['replay', 'close'])('remote %s save-script stays unsupported', async (command) => {
  await expect(
    prepareRemoteRequestArtifacts(
      { session: 'owned', command, positionals: [], flags: { saveScript: true } },
      REMOTE,
      signal,
      createTestHostEnvironment(),
    ),
  ).rejects.toMatchObject({ details: { reason: 'remote_script_lifecycle_unsupported' } });
});

test('existing client target refuses before dispatch unless force was granted', async () => {
  const root = mkdtempForTestSync('script-existing-');
  const destination = path.join(root, 'output.ad');
  fs.writeFileSync(destination, 'original');
  const req = {
    session: 'owned',
    command: 'open',
    positionals: ['Demo'],
    flags: { saveScript: destination },
  };
  await expect(
    prepareRemoteRequestArtifacts(req, REMOTE, signal, createTestHostEnvironment()),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { reason: 'script_target_exists' } });
  const forced = await prepareRemoteRequestArtifacts(
    { ...req, flags: { ...req.flags, force: true } },
    REMOTE,
    signal,
    createTestHostEnvironment(),
  );
  expect(forced.clientArtifactPaths?.savedScript).toBe(destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('original');
});

test('local publication retains its path and flags', async () => {
  const req = {
    session: 'owned',
    command: 'open',
    positionals: ['Demo'],
    flags: { saveScript: 'out.ad' },
  };
  const result = await prepareRemoteRequestArtifacts(
    req,
    { token: 'test' },
    signal,
    createTestHostEnvironment(),
  );
  expect(result.flags).toEqual(req.flags);
  expect(result.clientArtifactPaths).toBeUndefined();
});

test('remote open expands home on the caller', async () => {
  const root = mkdtempForTestSync('script-home-');
  const home = path.join(root, 'caller-home');
  const result = await prepareRemoteRequestArtifacts(
    {
      session: 'owned',
      command: 'open',
      positionals: ['Demo'],
      flags: { saveScript: '~/journey.ad' },
      meta: { cwd: root },
    },
    REMOTE,
    signal,
    createTestHostEnvironment({ env: { HOME: home } }),
  );
  expect(result.clientArtifactPaths?.savedScript).toBe(path.join(home, 'journey.ad'));
});
