import path from 'node:path';
import { expect, test } from 'vitest';
import { resolveDaemonPaths } from './daemon-resolution.ts';

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

test('a relative state dir keeps a step back out in the route it hands on', () => {
  // `path.resolve` would fold the step away, and folding is exactly what must not happen: through a symbolic
  // link, `link/..` lands BESIDE the link rather than inside its target, so the directory the substitution
  // means is a different directory than the one named. The state rule judges the route it is given, so a
  // route that steps back is passed on as spelled and refused there.
  const paths = resolveDaemonPaths('state/../elsewhere', { cwd: '/workspace/project' });

  expect(paths.baseDir).toBe('/workspace/project/state/../elsewhere');
});

test('a relative state dir spelled with a leading current directory is joined plainly', () => {
  const paths = resolveDaemonPaths('./state', { cwd: '/workspace/project' });

  expect(paths.baseDir).toBe('/workspace/project/state');
});
