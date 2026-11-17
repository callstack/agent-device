import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { configuredStateBaseDisagrees, resolveDaemonPaths } from './daemon-resolution.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

test('a relative state dir resolves against the working directory it is given', () => {
  const paths = resolveDaemonPaths('state/here', { cwd: '/workspace/project' });

  expect(paths.baseDir).toBe(path.resolve('/workspace/project', 'state/here'));
});

test('a relative state dir without a working directory is refused with a typed reason', () => {
  expect(() => resolveDaemonPaths('state/here')).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({ reason: 'relative_state_dir_without_cwd' }),
    }),
  );
});

test('an absolute state dir needs no working directory', () => {
  expect(resolveDaemonPaths('/var/agent-device/state').baseDir).toBe('/var/agent-device/state');
});

skipOnWindows(
  'a state dir spelled with a plain `..` is one directory, whether or not it exists yet',
  () => {
    // The spelling a package manager, a cache layout, or a hand-written `~/.zshrc` produces: a `..` whose step
    // back stays inside ordinary directories. `path.resolve` folds it, the kernel walks it, and both arrive at
    // `<root>/state`, so there is ONE directory and the daemon has no business refusing anything (#4584).
    // The absent half is the case that matters: a state directory is spelled LONG before it is created, and a
    // check that compares two unresolved texts then calls an ordinary setting a disagreement — which would
    // withhold every recording the daemon picks a path for, on a chain nothing disagrees about.
    const root = mkdtempForTestSync('agent-device-state-spelling-');
    fs.chmodSync(root, 0o700);
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lives'), { recursive: true });

    // Existing, and absent, on the same fold.
    expect(configuredStateBaseDisagrees(`${root}/cache/../lives`)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}/cache/../fresh`)).toBe(false);
    // A `..` that goes back through the directory it stands in, and one that cannot resolve at all because a
    // name ahead of it is absent. Neither names a second directory; the chain judgment answers the second.
    expect(configuredStateBaseDisagrees(`${root}/lives/..`)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}/missing/../lives`)).toBe(false);
    // A SEPARATOR is not a step: a trailing or doubled one, and a `.` component, name the same directory the
    // setting already named, and the comparison cuts them rather than treating the text as unfolded (#4584).
    expect(configuredStateBaseDisagrees(`${root}/cache/../lives/`)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}/cache//../lives`)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}/cache/../lives/.`)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}/lives/`)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}//lives`)).toBe(false);
    // Text with nothing to fold never is a disagreement, whatever it stands on — including a plain link.
    const link = path.join(root, 'linked');
    fs.symlinkSync(path.join(root, 'lives'), link);
    expect(configuredStateBaseDisagrees(link)).toBe(false);
    expect(configuredStateBaseDisagrees(`${root}/lives`)).toBe(false);
  },
);

skipOnWindows(
  'a state dir spelled with a `..` that comes after a link names two directories, exists or not',
  () => {
    // The one step `path.resolve` folds while the kernel walks THROUGH it: `alias` leads to `actual/x`, so the
    // setting's own text arrives at `<root>/actual/<name>` while every name built below the folded text lands
    // at `<root>/<name>` — beside the link, in a tree the setting's text does not name. Neither half may be
    // repaired for the other, so this answers true and the daemon refuses only its own destinations (#4584).
    const root = mkdtempForTestSync('agent-device-state-spelling-alias-');
    fs.chmodSync(root, 0o700);
    fs.mkdirSync(path.join(root, 'actual', 'x'), { recursive: true });
    fs.symlinkSync(path.join(root, 'actual', 'x'), path.join(root, 'alias'));

    // Nothing exists yet: still two directories, because the walk answers two different places to create in.
    expect(configuredStateBaseDisagrees(`${root}/alias/../fresh`)).toBe(true);
    expect(configuredStateBaseDisagrees(`${root}/alias/../fresh/`)).toBe(true);
    // The walked one exists and the folded one does not.
    fs.mkdirSync(path.join(root, 'actual', 'here'), { recursive: true });
    expect(configuredStateBaseDisagrees(`${root}/alias/../here`)).toBe(true);
    // Both exist, and they are not the same directory.
    fs.mkdirSync(path.join(root, 'here'), { recursive: true });
    expect(configuredStateBaseDisagrees(`${root}/alias/../here`)).toBe(true);
    expect(configuredStateBaseDisagrees(`${root}/alias/../here/`)).toBe(true);
  },
);
