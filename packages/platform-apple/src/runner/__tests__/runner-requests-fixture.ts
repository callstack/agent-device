import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type RunnerRequestEntry = {
  name: string;
  producer: string;
  request: Record<string, unknown>;
};

export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const COMMAND_ID_KEYS = ['commandId', 'statusCommandId'];

export function readRunnerRequestFixture(): RunnerRequestEntry[] {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'contracts/fixtures/runner-requests.json'), 'utf8'),
  ) as RunnerRequestEntry[];
}

/** The request as the wire carries it, with the random command ids pinned. */
function wireRunnerRequest(sent: unknown): Record<string, unknown> {
  const request = JSON.parse(JSON.stringify(sent)) as Record<string, unknown>;
  for (const key of COMMAND_ID_KEYS) {
    if (key in request) request[key] = '<commandId>';
  }
  return request;
}

export function compareRunnerRequestNames(
  left: Pick<RunnerRequestEntry, 'name'>,
  right: Pick<RunnerRequestEntry, 'name'>,
): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/**
 * Pins the requests one producer test captured, by site name, to that producer's fixture entries.
 * On a mismatch the diff shows the entries to paste into the fixture.
 */
export function assertProducedRunnerRequests(
  producerFile: string,
  captured: ReadonlyArray<readonly [name: string, sent: unknown]>,
): void {
  const producer = path.relative(REPO_ROOT, producerFile);
  const produced = captured
    .map(([name, sent]) => ({ name, producer, request: wireRunnerRequest(sent) }))
    .sort(compareRunnerRequestNames);
  assert.deepEqual(
    produced,
    readRunnerRequestFixture().filter((entry) => entry.producer === producer),
  );
}
