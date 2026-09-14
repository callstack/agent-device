import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseBenchmarkArgs } from './args.ts';

test('an empty command line keeps the default round count', () => {
  assert.deepEqual(parseBenchmarkArgs([]), {
    rounds: 5,
    jsonPath: undefined,
    captureFiles: [],
  });
});

test('rounds, json path, and every capture file are read from their flags', () => {
  assert.deepEqual(
    parseBenchmarkArgs([
      '--rounds',
      '9',
      '--json',
      'out/bench.json',
      '--file',
      'a.png',
      '--file',
      'b.png',
    ]),
    { rounds: 9, jsonPath: 'out/bench.json', captureFiles: ['a.png', 'b.png'] },
  );
});

test('a round count that is not a positive number falls back to the default', () => {
  assert.equal(parseBenchmarkArgs(['--rounds', '0']).rounds, 5);
  assert.equal(parseBenchmarkArgs(['--rounds', 'many']).rounds, 5);
  assert.equal(parseBenchmarkArgs(['--rounds', '2.4']).rounds, 2);
});

test('a flag with no value after it is ignored', () => {
  assert.deepEqual(parseBenchmarkArgs(['--json']), {
    rounds: 5,
    jsonPath: undefined,
    captureFiles: [],
  });
});
