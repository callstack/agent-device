import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseHardwareProfile } from './host.ts';

test('parses the Mac model and CPU identity from system_profiler output', () => {
  assert.deepEqual(
    parseHardwareProfile(
      [
        'Hardware:',
        '',
        '    Hardware Overview:',
        '      Model Name: MacBook Pro',
        '      Model Identifier: Mac16,8',
        '      Chip: Apple M4 Pro',
        '      Total Number of Cores: 12 (8 performance and 4 efficiency)',
      ].join('\n'),
    ),
    {
      model: 'MacBook Pro',
      modelIdentifier: 'Mac16,8',
      cpu: 'Apple M4 Pro',
      cpuCores: 12,
    },
  );
});

test('rejects incomplete host identity instead of recording an unknown machine', () => {
  assert.throws(
    () => parseHardwareProfile('Hardware:\n  Model Name: MacBook Pro'),
    /Model Identifier/,
  );
});
