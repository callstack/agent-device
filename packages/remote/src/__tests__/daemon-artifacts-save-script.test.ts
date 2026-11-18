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

/** A remote open refused, under Windows rules, before any existence probe, record, or dispatch. */
async function expectRefusedBeforeAnything(
  flags: Record<string, unknown>,
  options: Readonly<{
    host?: ReturnType<typeof createTestHostEnvironment>;
    cwd?: string;
    exposure?: string;
  }> = {},
): Promise<void> {
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
            meta: { cwd: options.cwd ?? String.raw`C:\work` },
          },
          REMOTE,
          signal,
          options.host ?? createTestHostEnvironment(),
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        details: {
          reason: 'script_ancestor_untrusted',
          exposure: options.exposure ?? 'unnamed_entry',
        },
      }),
    );
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
  }
}

const withForce = <T extends object>(cases: readonly T[]) =>
  cases.flatMap((entry) => [false, true].map((force) => ({ ...entry, force })));

test.each(
  withForce([
    { spelled: String.raw`\\localhost\pipe\recorder` },
    { spelled: String.raw`\\server\IPC$\recorder` },
    { spelled: String.raw`\\server\mailslot\recorder` },
  ]),
)(
  'a remote open to the Windows IPC namespace $spelled (force=$force) is refused before anything else',
  async ({ spelled, force }) => {
    await expectRefusedBeforeAnything({ saveScript: spelled, ...(force ? { force: true } : {}) });
  },
);

test.each(
  withForce([
    {
      name: 'a pipe-root working directory',
      cwd: String.raw`\\localhost\pipe`,
      spelled: 'journey.ad',
    },
    { name: 'an IPC$-root HOME', home: String.raw`\\server\IPC$`, spelled: '~/recorder' },
    { name: 'a pipe-root HOME', home: String.raw`\\localhost\pipe`, spelled: '~/recorder' },
  ]),
)(
  'a path joined to $name is refused before anything else (force=$force)',
  async ({ cwd, home, spelled, force }) => {
    // The spelling passes the raw check; only the path it expands to names the namespace.
    await expectRefusedBeforeAnything(
      { saveScript: spelled, ...(force ? { force: true } : {}) },
      {
        cwd,
        ...(home === undefined ? {} : { host: createTestHostEnvironment({ env: { HOME: home } }) }),
      },
    );
  },
);

// A root-relative path depends on the current drive, and an extended-length path is folded differently by the
// gate and by the system: neither is accepted as a script destination, nor as the base one is joined to.
test.each(
  withForce([
    { name: 'a root-relative destination', spelled: String.raw`\journey.ad` },
    { name: 'a drive-relative destination', spelled: 'C:journey.ad' },
    { name: 'a forward-slash root-relative destination', spelled: '/nested/journey.ad' },
    { name: 'three leading separators', spelled: '///journey.ad' },
    { name: 'an incomplete UNC volume', spelled: '//server' },
    { name: 'a root-relative destination stepping up', spelled: String.raw`\..\other\journey.ad` },
    { name: 'an extended drive destination', spelled: String.raw`\\?\C:\recordings\journey.ad` },
    {
      name: 'an extended UNC destination',
      spelled: String.raw`\\?\UNC\server\share\journey.ad`,
    },
    {
      name: 'an extended UNC destination stepping out of its share',
      spelled: String.raw`\\?\UNC\server\share\..\other\journey.ad`,
    },
    {
      name: 'an extended UNC IPC destination',
      spelled: String.raw`\\?\UNC\server\IPC$\..\other\journey.ad`,
    },
    {
      name: 'an extended destination with nested forward slashes',
      spelled: '//?/UNC/server/share/nested/journey.ad',
    },
    {
      name: 'a relative path on an extended UNC working directory',
      cwd: String.raw`\\?\UNC\server\share`,
      spelled: String.raw`..\other\journey.ad`,
    },
    {
      name: 'a relative path on an extended drive working directory',
      cwd: String.raw`\\?\C:\work`,
      spelled: 'journey.ad',
    },
    {
      name: 'a relative path on a root-relative working directory',
      cwd: String.raw`\work`,
      spelled: 'journey.ad',
    },
    {
      name: 'a relative HOME on an extended drive working directory',
      cwd: String.raw`\\?\C:\work`,
      home: 'profiles',
      spelled: '~/journey.ad',
    },
    {
      name: 'a home path on an extended UNC HOME',
      home: String.raw`\\?\UNC\server\share`,
      spelled: '~/journey.ad',
    },
    {
      name: 'a home path on a root-relative HOME',
      home: String.raw`\home`,
      spelled: '~/journey.ad',
    },
  ]),
)('$name is refused for its Windows form before anything else (force=$force)', async (entry) => {
  const { spelled, force } = entry;
  const cwd = 'cwd' in entry ? entry.cwd : undefined;
  const home = 'home' in entry ? entry.home : undefined;
  await expectRefusedBeforeAnything(
    { saveScript: spelled, ...(force ? { force: true } : {}) },
    {
      cwd,
      exposure: 'windows_path_form',
      ...(home === undefined ? {} : { host: createTestHostEnvironment({ env: { HOME: home } }) }),
    },
  );
});

test.each(
  withForce([
    {
      spelled: String.raw`C:\recordings\journey.ad`,
      expected: String.raw`C:\recordings\journey.ad`,
    },
    { spelled: 'journey.ad', cwd: String.raw`C:\work`, expected: String.raw`C:\work\journey.ad` },
    { spelled: 'journey.ad', cwd: 'C:\\', expected: String.raw`C:\journey.ad` },
    {
      spelled: String.raw`C:\journey.ad`,
      cwd: String.raw`\\?\C:\work`,
      expected: String.raw`C:\journey.ad`,
    },
    {
      spelled: String.raw`\\server\share\journey.ad`,
      expected: String.raw`\\server\share\journey.ad`,
    },
  ]),
)(
  'a plain Windows destination $spelled is probed and recorded as $expected (force=$force)',
  async (entry) => {
    const { spelled, expected, force } = entry;
    const cwd = 'cwd' in entry ? entry.cwd : String.raw`C:\work`;
    const probe = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      const result = await onWindowsRules(() =>
        prepareRemoteRequestArtifacts(
          {
            session: 'owned',
            command: 'open',
            positionals: ['Demo'],
            flags: { saveScript: spelled, ...(force ? { force: true } : {}) },
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
