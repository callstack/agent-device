import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
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

test.each(
  ['replay', 'close'].flatMap((command) =>
    [true, '', './missing/.'].map((saveScript) => ({ command, saveScript })),
  ),
)(
  'remote $command save-script stays unsupported for $saveScript',
  async ({ command, saveScript }) => {
    // The lifecycle is refused before the spelling is judged: a malformed path does not hide that the command
    // cannot save a script remotely at all.
    await expect(
      prepareRemoteRequestArtifacts(
        { session: 'owned', command, positionals: [], flags: { saveScript } },
        REMOTE,
        signal,
        createTestHostEnvironment(),
      ),
    ).rejects.toMatchObject({ details: { reason: 'remote_script_lifecycle_unsupported' } });
  },
);

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

test.each([
  { name: 'a relative `./missing/.`', spelled: () => './missing/.' },
  { name: 'an absolute `.` over a directory that exists', spelled: (root: string) => `${root}/.` },
  { name: 'an empty path', spelled: () => '' },
])('remote open refuses $name as an unnamed entry before anything else', async ({ spelled }) => {
  const root = mkdtempForTestSync('script-unnamed-');
  const probe = vi.spyOn(fs, 'existsSync');
  await expect(
    prepareRemoteRequestArtifacts(
      {
        session: 'owned',
        command: 'open',
        positionals: ['Demo'],
        flags: { saveScript: spelled(root) },
        meta: { cwd: root },
      },
      REMOTE,
      signal,
      createTestHostEnvironment(),
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'script_ancestor_untrusted', exposure: 'unnamed_entry' },
  });
  expect(probe).not.toHaveBeenCalled();
  probe.mockRestore();
  expect(fs.readdirSync(root)).toEqual([]);
});

/** Runs `task` under the Windows path rules, where the IPC namespaces are reachable. */
async function onWindowsRules<T>(task: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return await task();
  } finally {
    Object.defineProperty(process, 'platform', original!);
  }
}

/** A remote open refused as an unnamed entry before any existence probe, record, or dispatch. */
async function expectRefusedBeforeAnything(
  flags: Record<string, unknown>,
  host = createTestHostEnvironment(),
  cwd?: string,
): Promise<void> {
  const root = mkdtempForTestSync('script-ipc-');
  const probe = vi.spyOn(fs, 'existsSync');
  try {
    await onWindowsRules(() =>
      expect(
        prepareRemoteRequestArtifacts(
          {
            session: 'owned',
            command: 'open',
            positionals: ['Demo'],
            flags,
            meta: { cwd: cwd ?? root },
          },
          REMOTE,
          signal,
          host,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        details: { reason: 'script_ancestor_untrusted', exposure: 'unnamed_entry' },
      }),
    );
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
  }
  expect(fs.readdirSync(root)).toEqual([]);
}

test.each(
  [
    String.raw`\\localhost\pipe\recorder`,
    String.raw`\\?\UNC\localhost\pipe\recorder`,
    String.raw`\\server\IPC$\recorder`,
    String.raw`\\?\UNC\server\ipc$\recorder`,
    String.raw`\\server\mailslot\recorder`,
    String.raw`\\?\UNC\server\MAILSLOT\recorder`,
  ].flatMap((spelled) => [false, true].map((force) => ({ spelled, force }))),
)(
  'a remote open to the Windows IPC namespace $spelled (force=$force) is refused before anything else',
  async ({ spelled, force }) => {
    await expectRefusedBeforeAnything({ saveScript: spelled, ...(force ? { force: true } : {}) });
  },
);

test.each([false, true])(
  'a relative path joined to a pipe-root working directory is refused before anything else (force=%s)',
  async (force) => {
    await expectRefusedBeforeAnything(
      { saveScript: 'journey.ad', ...(force ? { force: true } : {}) },
      createTestHostEnvironment(),
      String.raw`\\localhost\pipe`,
    );
  },
);

test.each(
  [String.raw`\\localhost\pipe`, String.raw`\\server\IPC$`].flatMap((home) =>
    [false, true].map((force) => ({ home, force })),
  ),
)(
  'a home path joined to the IPC-root HOME $home is refused before anything else (force=$force)',
  async ({ home, force }) => {
    // `~/recorder` passes the raw check; only the path it expands to names the namespace.
    await expectRefusedBeforeAnything(
      { saveScript: '~/recorder', ...(force ? { force: true } : {}) },
      createTestHostEnvironment({ env: { HOME: home } }),
    );
  },
);

test.each(
  [
    String.raw`\\server\IPC$`,
    String.raw`\\server\pipe\work`,
    String.raw`\\?\UNC\server\IPC$`,
    String.raw`\\?\UNC\server\mailslot\work`,
  ].flatMap((cwd) => [false, true].map((force) => ({ cwd, force }))),
)(
  'a root-relative path on the IPC base $cwd is refused before anything else (force=$force)',
  async ({ cwd, force }) => {
    // `\journey.ad` reads as absolute, but it stands on the working directory's root: an IPC share here.
    await expectRefusedBeforeAnything(
      { saveScript: String.raw`\journey.ad`, ...(force ? { force: true } : {}) },
      createTestHostEnvironment(),
      cwd,
    );
  },
);

test.each(
  [
    { cwd: String.raw`\\server\share\work`, expected: String.raw`\\server\share\journey.ad` },
    {
      cwd: String.raw`\\?\UNC\server\share\work`,
      expected: String.raw`\\?\UNC\server\share\journey.ad`,
    },
    { cwd: String.raw`C:\work`, expected: String.raw`C:\journey.ad` },
    { cwd: String.raw`\\?\C:\work`, expected: String.raw`\\?\C:\journey.ad` },
  ].flatMap((base) => [false, true].map((force) => ({ ...base, force }))),
)(
  'a root-relative path on $cwd is probed and recorded as $expected (force=$force)',
  async ({ cwd, expected, force }) => {
    const probe = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      const result = await onWindowsRules(() =>
        prepareRemoteRequestArtifacts(
          {
            session: 'owned',
            command: 'open',
            positionals: ['Demo'],
            flags: { saveScript: String.raw`\journey.ad`, ...(force ? { force: true } : {}) },
            meta: { cwd },
          },
          REMOTE,
          signal,
          createTestHostEnvironment(),
        ),
      );

      expect(result.clientArtifactPaths?.savedScript).toBe(expected);
      if (force) expect(probe).not.toHaveBeenCalled();
      else expect(probe.mock.calls).toEqual([[expected]]);
    } finally {
      probe.mockRestore();
    }
  },
);
