import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mutationSeed, MUTATION_SEED_ENV } from './seed.ts';

test('mutation seeds accept the fast-check integer range and reject ambiguous input', () => {
  assert.equal(mutationSeed(undefined), undefined);
  assert.equal(mutationSeed('0'), 0);
  assert.equal(mutationSeed('2147483647'), 2147483647);
  for (const value of ['', '-1', '1.5', 'NaN', '2147483648'])
    assert.throws(() => mutationSeed(value), /integer/);
});

test('the worker setup reproduces property samples across separate processes', () => {
  const sample = (seed: string) =>
    runCmdSync(
      'node',
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        'import fc from "fast-check"; import "./scripts/mutation/seed-setup.ts"; console.log(JSON.stringify(fc.sample(fc.integer(), 10)));',
      ],
      {
        cwd: path.resolve(import.meta.dirname, '../..'),
        env: { ...process.env, [MUTATION_SEED_ENV]: seed },
      },
    ).stdout;
  assert.equal(sample('123'), sample('123'));
  assert.notEqual(sample('123'), sample('124'));
});
