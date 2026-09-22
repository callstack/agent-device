import { classifyFailure, formatCliFailure, snapshotHasAnchor, type CliResult } from './command.ts';
import { BenchmarkCellAdmissionError, BenchmarkContentionError } from './lifecycle.ts';
import { asRecord, readString } from './result-values.ts';
import type { Failure, ScreenFixture } from './types.ts';

export type FixtureAnchorPhase = 'opened' | 'prepared' | 'sample';

/**
 * Setup reads are untimed, so an anchor read that lands before the app has mounted its first tree
 * is waited out instead of stopping the run. The budget must stay far below the operation timeout
 * it precedes; a fixture that never exposes its anchor still stops the run.
 */
const FIXTURE_ANCHOR_ADMISSION_BUDGET_MS = 30_000;
const FIXTURE_ANCHOR_POLL_INTERVAL_MS = 500;

export type FixtureOperationResult = {
  ok: boolean;
  payload: unknown;
  failure?: Failure;
  message?: string;
  command?: string;
};

export type FixturePreparationDriver = {
  observe: () => FixtureOperationResult | Promise<FixtureOperationResult>;
  scrollToBottom: () => FixtureOperationResult | Promise<FixtureOperationResult>;
  openAlert: () => FixtureOperationResult | Promise<FixtureOperationResult>;
};

export type FixturePreparationOptions = {
  anchorBudgetMs?: number;
  anchorPollMs?: number;
};

export async function prepareFixture(
  fixture: ScreenFixture,
  driver: FixturePreparationDriver,
  options: FixturePreparationOptions = {},
): Promise<void> {
  await observeFixtureAnchor(fixture, driver, 'opened', options);
  if (fixture.setupAction !== 'open-alert') return;

  const scrolled = await driver.scrollToBottom();
  requireFixtureOperationSuccess(scrolled, `${fixture.id} setup scroll`, 'cell-state');
  const alert = await driver.openAlert();
  requireFixtureOperationSuccess(alert, `${fixture.id} setup action`, 'cell-state');
  await observeFixtureAnchor(fixture, driver, 'prepared', options);
}

async function observeFixtureAnchor(
  fixture: ScreenFixture,
  driver: FixturePreparationDriver,
  phase: Exclude<FixtureAnchorPhase, 'sample'>,
  options: FixturePreparationOptions,
): Promise<FixtureOperationResult> {
  const budgetMs = options.anchorBudgetMs ?? FIXTURE_ANCHOR_ADMISSION_BUDGET_MS;
  const pollMs = options.anchorPollMs ?? FIXTURE_ANCHOR_POLL_INTERVAL_MS;
  const operation =
    phase === 'opened'
      ? `${fixture.id} semantic anchor observation`
      : `${fixture.id} post-setup semantic anchor observation`;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await driver.observe();
    requireFixtureOperationSuccess(result, operation, 'fixture-anchor');
    if (hasFixtureAnchor(result.payload, fixture, phase)) return result;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new BenchmarkCellAdmissionError(
        'fixture-anchor',
        `Fixture ${fixture.id} ${phase} did not expose the exact anchor ` +
          `${JSON.stringify(expectedAnchor(fixture, phase))} within ${budgetMs}ms.`,
        result.command,
      );
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
}

function hasFixtureAnchor(
  payload: unknown,
  fixture: ScreenFixture,
  phase: FixtureAnchorPhase,
): boolean {
  return snapshotHasAnchor(payload, expectedAnchor(fixture, phase));
}

export function requireFixtureAnchor(
  payload: unknown,
  fixture: ScreenFixture,
  phase: FixtureAnchorPhase,
  command = 'agent-device snapshot',
): void {
  if (hasFixtureAnchor(payload, fixture, phase)) return;
  throw new BenchmarkCellAdmissionError(
    'fixture-anchor',
    `Fixture ${fixture.id} ${phase} did not expose the exact anchor ${JSON.stringify(
      expectedAnchor(fixture, phase),
    )}.`,
    command,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fixtureOperationFromCli(
  result: CliResult,
  command: string,
): FixtureOperationResult {
  if (result.ok) return { ok: true, payload: result.payload, command };
  const failure = classifyFailure(result.payload, result);
  return {
    ok: false,
    payload: result.payload,
    failure,
    message: formatCliFailure(command, failure, result),
    command,
  };
}

export function fixtureOperationFromClient(
  payload: unknown,
  command: string,
): FixtureOperationResult {
  const record = asRecord(payload);
  const first = Array.isArray(record?.results) ? asRecord(record.results[0]) : undefined;
  const ok = record?.ok !== false && first?.ok !== false;
  if (ok) return { ok: true, payload, command };
  const error = asRecord(record?.error);
  const code = readString(error?.code);
  const message = readString(error?.message) ?? `${command} failed`;
  const failure: Failure = {
    category: 'upstream',
    ...(code ? { code } : {}),
    message,
  };
  return { ok: false, payload, failure, message, command };
}

function expectedAnchor(fixture: ScreenFixture, phase: FixtureAnchorPhase): string {
  if (phase === 'opened') return fixture.anchorText;
  return fixture.postSetupAnchorText ?? fixture.anchorText;
}

export function requireFixtureOperationSuccess(
  result: FixtureOperationResult,
  operation: string,
  reason: 'cell-state' | 'fixture-anchor',
): void {
  if (result.ok) return;
  const message = result.message ?? `${operation} failed`;
  if (result.failure?.code === 'DEVICE_IN_USE') {
    throw new BenchmarkContentionError(message, result.command ?? operation);
  }
  throw new BenchmarkCellAdmissionError(reason, message, result.command ?? operation);
}
