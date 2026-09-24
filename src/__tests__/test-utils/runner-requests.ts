import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type RunnerRequestEntry = { name: string; producer: string; request: unknown };

/**
 * Pins the runner requests one producer test captured, by site name, to that producer's entries in
 * contracts/fixtures/runner-requests.json.
 */
export function expectProducedRunnerRequests(
  producerFile: string,
  captured: ReadonlyArray<readonly [name: string, sent: unknown]>,
): void {
  const producer = path.relative(REPO_ROOT, producerFile);
  const fixture = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts/fixtures/runner-requests.json'), 'utf8'),
  ) as RunnerRequestEntry[];
  const produced = captured
    .map(([name, sent]) => ({ name, producer, request: JSON.parse(JSON.stringify(sent)) }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  expect(produced).toEqual(fixture.filter((entry) => entry.producer === producer));
}
