import { expect, test } from 'vitest';
import { packedCoreAbsenceFailures } from '../lib/packed-core-absence.ts';

const exclusions = [
  {
    owner: 'fixture',
    paths: [/^dist\/src\/agent-browser-tool\.js$/],
    markers: ['Managed web backend install produced no runnable entry.'],
  },
];

test('packed core can keep web help and adapters', () => {
  expect(
    packedCoreAbsenceFailures(
      exclusions,
      ['dist/src/platform-runtime-network-web-transport.js', 'dist/src/plugin.d.ts'],
      () => 'agent-device plugins add @agent-device/web',
    ),
  ).toEqual([]);
});

test('packed core identifies the forbidden paths and bundled implementation markers', () => {
  expect(
    packedCoreAbsenceFailures(
      exclusions,
      ['dist/src/agent-browser-tool.js', 'dist/src/reassigned-chunk.js'],
      (file) =>
        file.endsWith('reassigned-chunk.js')
          ? 'Managed web backend install produced no runnable entry.'
          : '',
    ),
  ).toEqual([
    'fixture: forbidden packed path dist/src/agent-browser-tool.js',
    'fixture: forbidden implementation marker in dist/src/reassigned-chunk.js: Managed web backend install produced no runnable entry.',
  ]);
});
