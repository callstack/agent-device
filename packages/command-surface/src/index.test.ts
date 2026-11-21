import { expect, expectTypeOf, test } from 'vitest';
import { prepareDaemonCommandRequest, type DaemonCommandName } from './index.ts';
import type { BatchCommandName } from './batch/projection.ts';

const host = { env: {}, cwd: '/workspace' };

test('type projects a structured ref through the minted-ref gate', async () => {
  // The typed Node client skips the metadata reader, so the projection itself must refuse a
  // non-minted ref instead of typing it into the focused field (#4870 review).
  await expect(
    prepareDaemonCommandRequest('type', { ref: 'Email', text: 'x' }, host),
  ).rejects.toThrow('is not a snapshot ref');
  const request = await prepareDaemonCommandRequest('type', { ref: 'e12', text: 'x' }, host);
  expect(request.positionals).toEqual(['@e12', 'x']);
});

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

test('every structured batch command has a daemon writer', () => {
  expectTypeOf<BatchCommandName>().toExtend<DaemonCommandName>();
});
