/**
 * `toDaemonFindData` is where a find read's result becomes the response body, so it is the last
 * place a ref-less match can be turned back into an address: the runtime hands over `ref?: string`
 * and an unconditional `ref: match.ref` would publish a key whose value is `undefined`.
 */
import { expect, test } from 'vitest';
import { toDaemonFindData } from '../selector-recording.ts';

test('a listed match with no ref publishes no ref key', () => {
  const data = toDaemonFindData({
    kind: 'list',
    matches: [
      { ref: '@e5', node: { index: 0, ref: 'e5', type: 'button', label: 'Add' } },
      { node: { index: 1, type: 'StaticText', value: 'Item saved' } },
    ],
  });

  const matches = data.matches as Array<Record<string, unknown>>;
  expect(matches[0]).toMatchObject({ ref: '@e5' });
  expect('ref' in matches[1]!).toBe(false);
});

test('a ref-less text read publishes no ref key', () => {
  const data = toDaemonFindData({
    kind: 'text',
    text: 'Item saved',
    node: { index: 0, type: 'StaticText', value: 'Item saved' },
  });

  expect('ref' in data).toBe(false);
  expect(data.text).toBe('Item saved');
});

test('a read that resolved to a ref still publishes it', () => {
  const data = toDaemonFindData({
    kind: 'attrs',
    ref: '@e9',
    node: { index: 0, ref: 'e9', type: 'button', label: 'Add' },
  });

  expect(data.ref).toBe('@e9');
});

test('public selector nodes retain bar membership while dropping private settle provenance', () => {
  const node = { index: 0, systemBar: 'status' as const, systemChrome: true as const };
  for (const result of [
    { kind: 'attrs' as const, node },
    { kind: 'text' as const, text: 'Clock', node },
    { kind: 'list' as const, matches: [{ node }] },
  ]) {
    const data = toDaemonFindData(result) as {
      node?: Record<string, unknown>;
      matches?: Array<{ node: Record<string, unknown> }>;
    };
    const published = result.kind === 'list' ? data.matches?.[0]?.node : data.node;
    expect(published?.systemBar).toBe('status');
    expect(published).not.toHaveProperty('systemChrome');
  }
});
