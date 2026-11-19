import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { foldParentRelativeStateRoute, resolveDaemonPaths } from './daemon-resolution.ts';

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

test('a relative state dir needs no working directory when it is absolute', () => {
  expect(resolveDaemonPaths('/var/agent-device/state').baseDir).toBe('/var/agent-device/state');
});

test('an ordinary parent-relative state dir stays accepted and is folded once', () => {
  // `--state-dir ../shared-state` beside a checkout is an existing configuration and keeps working. What it may
  // not do is survive resolution UN-folded: every record name is derived with `path.join`, which folds the step
  // away, so an un-folded base would be judged as one directory and written into as another.
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-resolution-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);

  const paths = resolveDaemonPaths('../shared-state', { cwd: project });

  expect(paths.baseDir).toBe(path.join(root, 'shared-state'));
  expect(paths.baseDir).not.toContain('..');
});

test('every record name of a parent-relative state dir comes from one accepted base', () => {
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-resolution-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);

  const paths = resolveDaemonPaths('state/../../shared-state', { cwd: project });

  // The base is the single root of every derived name, so `daemon.json` records a directory that holds them.
  for (const name of [
    paths.infoPath,
    paths.lockPath,
    paths.logPath,
    paths.allocationsDir,
    paths.sessionsDir,
  ]) {
    expect(
      path.dirname(name) === paths.baseDir || name.startsWith(`${paths.baseDir}${path.sep}`),
    ).toBe(true);
    expect(name).not.toContain('..');
  }
  expect(paths.baseDir).toBe(path.join(root, 'shared-state'));
});

test('a parent step out of a symbolic link is refused with a typed reason', () => {
  // `name/..` returns to the parent of whatever NAME resolves to, so with a link at `name` the spelling means the
  // target's parent while the fold says the directory the text names. The route then has two meanings, and no
  // base could be proven to be the one the state rule judges.
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-resolution-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(project, 'linked'));

  expect(() => resolveDaemonPaths('linked/../shared-state', { cwd: project })).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({ reason: 'state_dir_parent_step_through_link' }),
    }),
  );
});

test('a parent step out of a directory that does not stand yet is folded as spelled', () => {
  // Before the daemon's first start the whole route is absent, and absence cannot be a link: this is the ordinary
  // not-yet-created case, and the state rule judges the ground it creates the level in.
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-resolution-'));

  const paths = resolveDaemonPaths('../shared-state', { cwd: path.join(root, 'not-made-yet') });

  expect(paths.baseDir).toBe(path.join(root, 'shared-state'));
});

test('a state dir whose parent step is part of a name is not a step back out', () => {
  const paths = resolveDaemonPaths('state/..hidden', { cwd: '/workspace/project' });

  expect(paths.baseDir).toBe(path.resolve('/workspace/project', 'state/..hidden'));
});

test('a Windows drive route keeps its drive through the fold', () => {
  // A fold that rebuilds a route with a leading `/` moves a Windows state dir out of its own drive scope, and the
  // records then land beside a root nothing chose.
  const route = win('C:', 'work', 'state', '..', 'shared-state');
  expect(foldParentRelativeStateRoute(route, route, path.win32)).toBe(
    win('C:', 'work', 'shared-state'),
  );
  const toRoot = win('C:', 'state', '..');
  expect(foldParentRelativeStateRoute(toRoot, toRoot, path.win32)).toBe('C:\\');
});

test('a Windows UNC route keeps its server and share through the fold', () => {
  const route = win('', '', 'srv', 'share', 'work', 'state', '..', 'shared-state');
  expect(foldParentRelativeStateRoute(route, route, path.win32)).toBe(
    win('', '', 'srv', 'share', 'work', 'shared-state'),
  );
  // A server and share are a root, so a step with nothing below it to leave changes nothing.
  const toScope = win('', '', 'srv', 'share', 'state', '..', '..');
  expect(foldParentRelativeStateRoute(toScope, toScope, path.win32)).toBe(
    win('', '', 'srv', 'share') + '\\',
  );
});

test('a fold uses the host separator for the route it returns', () => {
  expect(foldParentRelativeStateRoute('x', '/work/state/../shared-state', path.posix)).toBe(
    '/work/shared-state',
  );
});

test('a POSIX name containing a backslash is not split into a step back out', () => {
  // On POSIX the backslash is an ordinary filename byte, so a name spelled with one is ONE directory name.
  // Splitting on both separators would see a `..` the host never sees and fold a route that asks for none.
  const spelled = String.raw`/work/state\..\elsewhere`;
  expect(foldParentRelativeStateRoute(spelled, spelled, path.posix)).toBe(spelled);
});

test('an lstat fault on the stepped-out-of directory is refused, not folded', () => {
  // Absence and a refused lookup are different answers: absence says the level cannot be a link, a fault says
  // nothing about what stands there. Folding a route the rule could not check is how records reach a base that
  // was never judged.
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-resolution-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation((() => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  }) as unknown as typeof fs.lstatSync);

  try {
    expect(() => resolveDaemonPaths('../shared-state', { cwd: project })).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        details: expect.objectContaining({ reason: 'state_dir_parent_step_unverified' }),
      }),
    );
  } finally {
    lstat.mockRestore();
  }
});

/** Builds a Windows route from its parts, so a test pins a SCOPE without spelling backslash escapes. */
function win(...parts: readonly string[]): string {
  return parts.join('\\');
}
