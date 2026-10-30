import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { readRunnerRequestFixture, REPO_ROOT } from '@agent-device/test-kit';

/**
 * The repository-wide half of the runner request pin (`contracts/fixtures/runner-requests.json`):
 * the drives that produce each entry live in the apple-runner package, platform-apple, and root, so
 * the guard that reads their sources belongs to no one package. Each package drive pins its own
 * entries with `assertProducedRunnerRequests`; this file proves every producer is such a drive and
 * that no drive writes a request itself.
 */

test('every runner request producer is a dedicated runner-requests drive that checks its own entries', () => {
  for (const producer of new Set(readRunnerRequestFixture().map((entry) => entry.producer))) {
    const source = fs.readFileSync(path.join(REPO_ROOT, producer), 'utf8');
    assert.ok(
      producer.endsWith('runner-requests.test.ts') &&
        source.includes('assertProducedRunnerRequests(import.meta.filename'),
      `${producer} must be a dedicated *runner-requests.test.ts drive that checks its own entries`,
    );
  }
});

const REQUEST_LITERAL = /\bcommand\s*:(?!\s*RunnerCommand\b)/;
const DIRECT_SEND = new RegExp(
  `\\b(?:${['runAppleRunnerCommand', 'executeRunnerCommandWithSession', 'waitForRunner', 'sendRunnerCommandOnce'].join('|')})\\s*\\(`,
);

test('runner request drives send only requests production builds', () => {
  const producers = readRunnerRequestFixture().map((entry) => path.join(REPO_ROOT, entry.producer));
  const sources = [
    ...new Set(producers),
    path.join(REPO_ROOT, 'packages/test-kit/src/runner-requests.fixtures.ts'),
    path.join(REPO_ROOT, 'packages/platform-apple/src/__tests__/recording-runner-provider.ts'),
  ];
  const offending = sources.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        REQUEST_LITERAL.test(line) || DIRECT_SEND.test(line)
          ? [`${path.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );
  assert.deepEqual(offending, []);
});
