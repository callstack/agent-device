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

test('a state dir that steps back out is refused with a typed reason', () => {
  // A `..` cannot be honoured by anything downstream: record names are derived with `path.join`, which folds
  // the step away, so such a route would be judged as one directory and written into as another. The spelling
  // is refused where it is read, so the caller fixes the name instead of running with records in a directory
  // it did not point at.
  for (const spelled of ['state/../elsewhere', '/workspace/state/../elsewhere']) {
    expect(() => resolveDaemonPaths(spelled, { cwd: '/workspace/project' })).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        details: expect.objectContaining({ reason: 'state_dir_parent_escape' }),
      }),
    );
  }
});

test('a state dir whose parent step is part of a name is not a step back out', () => {
  const paths = resolveDaemonPaths('state/..hidden', { cwd: '/workspace/project' });

  expect(paths.baseDir).toBe(path.resolve('/workspace/project', 'state/..hidden'));
});
