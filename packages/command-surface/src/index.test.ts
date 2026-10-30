import { expect, test } from 'vitest';
import { prepareDaemonCommandRequest } from './index.ts';

const host = { env: {}, cwd: '/workspace' };

test('projection preserves declared command names and rejects an unknown writer', async () => {
  expect(await prepareDaemonCommandRequest('snapshot', {}, host)).toMatchObject({
    command: 'snapshot',
  });

  // @ts-expect-error A misspelled command is outside the literal writer keys.
  await expect(prepareDaemonCommandRequest('snaphot', {}, host)).rejects.toThrow(
    'Missing daemon writer for command: snaphot',
  );

  // @ts-expect-error Metro has a client-owned path, not a daemon writer.
  await expect(prepareDaemonCommandRequest('metro', {}, host)).rejects.toThrow(
    'Missing daemon writer for command: metro',
  );
});

test('projection rejects an invalid shared client option', async () => {
  // @ts-expect-error The shared client direction field is a string.
  await expect(prepareDaemonCommandRequest('scroll', { direction: 3 }, host)).rejects.toThrow(
    'scroll requires direction',
  );
});
