import { expect, test } from 'vitest';
import { createPerfRuntimeHost } from './platform-runtime-perf-host.ts';

test('exposes family-specific mechanics without a bind or platform switch surface', () => {
  const host = createPerfRuntimeHost();

  expect(Object.keys(host).sort()).toEqual(['android', 'apple', 'harmony']);
  expect(host).not.toHaveProperty('bind');
  expect(Object.keys(host.apple)).toContain('frameSampling');
  expect(Object.keys(host.android)).not.toContain('frameSampling');
  expect(Object.keys(host.harmony)).toEqual(['sampleMemory']);
});
