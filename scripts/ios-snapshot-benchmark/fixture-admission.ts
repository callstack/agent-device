import { classifyFailure, formatCliFailure, snapshotHasAnchor, type CliResult } from './command.ts';
import { BenchmarkCellAdmissionError, BenchmarkContentionError } from './lifecycle.ts';
import { asRecord, readString } from './result-values.ts';
import type { Failure, ScreenFixture } from './types.ts';

export type FixtureAnchorPhase = 'opened' | 'prepared' | 'sample';

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

export async function prepareFixture(
  fixture: ScreenFixture,
  driver: FixturePreparationDriver,
): Promise<void> {
  const opened = await driver.observe();
  requireFixtureOperationSuccess(
    opened,
    `${fixture.id} semantic anchor observation`,
    'fixture-anchor',
  );
  requireFixtureAnchor(opened.payload, fixture, 'opened', opened.command);
  if (fixture.setupAction !== 'open-alert') return;

  const scrolled = await driver.scrollToBottom();
  requireFixtureOperationSuccess(scrolled, `${fixture.id} setup scroll`, 'cell-state');
  const alert = await driver.openAlert();
  requireFixtureOperationSuccess(alert, `${fixture.id} setup action`, 'cell-state');
  const prepared = await driver.observe();
  requireFixtureOperationSuccess(
    prepared,
    `${fixture.id} post-setup semantic anchor observation`,
    'fixture-anchor',
  );
  requireFixtureAnchor(prepared.payload, fixture, 'prepared', prepared.command);
}

export function requireFixtureAnchor(
  payload: unknown,
  fixture: ScreenFixture,
  phase: FixtureAnchorPhase,
  command = 'agent-device snapshot',
): void {
  const anchor = expectedAnchor(fixture, phase);
  if (snapshotHasAnchor(payload, anchor)) return;
  throw new BenchmarkCellAdmissionError(
    'fixture-anchor',
    `Fixture ${fixture.id} ${phase} did not expose the exact anchor ${JSON.stringify(anchor)}.`,
    command,
  );
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
