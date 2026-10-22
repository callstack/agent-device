import fs from 'node:fs';
import path from 'node:path';
import { executeValidationCommand } from './command-execution.ts';
import { acquireValidationLock } from './host-lock.ts';
import { abortOnTerminationSignal } from './termination.ts';
import { gitValue, readCheckoutState, type CheckoutState } from './checkout-state.ts';
import type { TestReport } from './test-report.ts';
import type { CheckId, CheckPlan } from './model.ts';

export type CheckResult = {
  id: string;
  status: 'not-run' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped' | 'deduplicated';
  command?: string[];
  exitCode?: number;
  durationMs?: number;
  logPath?: string;
  reason?: string;
  testReportPaths?: string[];
  testReportError?: string;
  tests?: (Omit<TestReport, 'failures'> & {
    failures: TestReport['failures'];
    omittedFailures: number;
  })[];
};

export type ExecutionReceipt = {
  version: 1;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  status: 'waiting' | 'running' | 'passed' | 'failed' | 'cancelled';
  exitCode: number;
  refs: {
    base: string;
    head: string;
    resolvedBase?: string;
    resolvedHead?: string;
    mergeBase?: string;
  };
  initial?: CheckoutState;
  final?: CheckoutState;
  checkoutChanged: boolean;
  exactCommit: boolean;
  plan?: CheckPlan;
  changedFiles?: string[];
  results: CheckResult[];
  error?: string;
};

export type ValidationContext = {
  receipt: ExecutionReceipt;
  execute: (command: string[], cwd: string, id: string) => Promise<number>;
  skip: (id: CheckId, reason: string, deduplicated: boolean) => void;
};

export async function runValidation(
  cwd: string,
  args: { base: string; head: string; json: boolean; full?: boolean },
  task: (context: ValidationContext) => Promise<number>,
): Promise<number> {
  const run = openValidationRun(cwd, args);
  const { receipt, controller, save, report, receiptPath, cancellation } = run;
  let release: (() => Promise<void>) | undefined;
  save();
  report(`[receipt] ${receiptPath}`);

  try {
    const lock = await acquireValidationLock(controller.signal);
    release = lock.release;
    prepareCheckout(cwd, args, receipt);
    receipt.status = 'running';
    save();

    receipt.exitCode = await task({
      receipt,
      execute: (command, commandCwd, id) =>
        executeValidationCommand(run, lock, checkResult(receipt, id), command, commandCwd),
      skip: (id, reason, deduplicated) => {
        Object.assign(checkResult(receipt, id), {
          status: deduplicated ? 'deduplicated' : 'skipped',
          reason,
        });
        save();
      },
    });
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    report(`[error] ${receipt.error}`);
    receipt.exitCode = cancellation.code || 1;
  } finally {
    await closeValidationRun(run, cwd, release);
  }
  report(
    `[${receipt.status}] exactCommit=${receipt.exactCommit}; receipt=${receiptPath}${receipt.error ? `; ${receipt.error}` : ''}`,
  );
  if (args.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.exitCode;
}

type ValidationArgs = { base: string; head: string; json: boolean; full?: boolean };
export type ValidationRun = ReturnType<typeof openValidationRun>;

function openValidationRun(cwd: string, args: ValidationArgs) {
  const root = path.join(cwd, '.tmp', 'validation');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'run-'));
  const receiptPath = path.join(directory, 'receipt.json');
  const receipt: ExecutionReceipt = {
    version: 1,
    cwd,
    startedAt: new Date().toISOString(),
    status: 'waiting',
    exitCode: 1,
    refs: { base: args.base, head: args.head },
    checkoutChanged: false,
    exactCommit: false,
    results: [],
  };
  const save = () => fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const report = (line: string) => process.stderr.write(`${line}\n`);
  const controller = new AbortController();
  const { cancellation, dispose } = abortOnTerminationSignal(controller);
  return {
    receipt,
    directory,
    receiptPath,
    controller,
    cancellation,
    save,
    report,
    dispose,
  };
}

function prepareCheckout(cwd: string, args: ValidationArgs, receipt: ExecutionReceipt): void {
  receipt.initial = readCheckoutState(cwd);
  if (!args.full) receipt.refs.resolvedBase = gitValue(cwd, ['rev-parse', `${args.base}^{commit}`]);
  receipt.refs.resolvedHead = gitValue(cwd, ['rev-parse', `${args.head}^{commit}`]);
  if (receipt.refs.resolvedBase)
    receipt.refs.mergeBase = gitValue(cwd, [
      'merge-base',
      receipt.refs.resolvedBase,
      receipt.refs.resolvedHead,
    ]);
  if (
    receipt.refs.resolvedHead !== receipt.initial.head ||
    (args.head !== 'HEAD' && receipt.initial.status !== '')
  ) {
    throw new Error(
      '--head must name the checked-out commit. An explicit ref also requires a clean checkout.',
    );
  }
}

function finishCheckout(cwd: string, receipt: ExecutionReceipt): void {
  if (receipt.initial) {
    receipt.final = readCheckoutState(cwd);
    receipt.checkoutChanged = receipt.initial.fingerprint !== receipt.final.fingerprint;
    receipt.exactCommit =
      !receipt.initial.status &&
      !receipt.final.status &&
      !receipt.checkoutChanged &&
      receipt.initial.head === receipt.refs.resolvedHead;
    if (receipt.checkoutChanged) {
      receipt.exitCode = 1;
      receipt.error = 'Checkout changed during validation. Run again after edits stop.';
    }
  }
}

function checkResult(receipt: ExecutionReceipt, id: string): CheckResult {
  let result = receipt.results.find((value) => value.id === id);
  if (!result) {
    result = { id, status: 'not-run' };
    receipt.results.push(result);
  }
  return result;
}

async function closeValidationRun(
  run: ValidationRun,
  cwd: string,
  release: (() => Promise<void>) | undefined,
): Promise<void> {
  const { receipt, cancellation, save } = run;
  try {
    finishCheckout(cwd, receipt);
  } catch (error) {
    receipt.exitCode = 1;
    receipt.error = error instanceof Error ? error.message : String(error);
  }
  try {
    await release?.();
  } catch (error) {
    receipt.exitCode = 1;
    receipt.error = error instanceof Error ? error.message : String(error);
  }
  run.dispose();
  receipt.exitCode = cancellation.code || receipt.exitCode;
  receipt.status = cancellation.code ? 'cancelled' : receipt.exitCode === 0 ? 'passed' : 'failed';
  receipt.finishedAt = new Date().toISOString();
  save();
}
