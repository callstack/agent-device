import { expect, test } from 'vitest';
import { captureHostEnvironment } from './host-environment.ts';

test('captureHostEnvironment copies the environment and reads the working directory once', () => {
  const source = {
    env: { HOME: '/home/a', EMPTY: undefined } as Record<string, string | undefined>,
    cwd: () => '/work',
  };
  const host = captureHostEnvironment(source);

  source.env.HOME = '/home/b';
  source.env.ADDED = 'late';

  expect(host).toEqual({ env: { HOME: '/home/a', EMPTY: undefined }, cwd: '/work' });
  expect(host.env).not.toBe(source.env);
});
