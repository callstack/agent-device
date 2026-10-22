import fs from 'node:fs';
import path from 'node:path';
import { runLockedCommand, type ValidationLock } from './host-lock.ts';
import type { CheckResult, ValidationRun } from './execution.ts';
import type { TestReport } from './test-report.ts';

export async function executeValidationCommand(
  run: ValidationRun,
  lock: ValidationLock,
  result: CheckResult,
  command: string[],
  cwd: string,
): Promise<number> {
  run.controller.signal.throwIfAborted();
  const index = run.receipt.results.indexOf(result);
  const logPath = path.join(run.directory, `${index}.log`);
  const reportPrefix = path.join(run.directory, `${index}.tests`);
  Object.assign(result, { command, status: 'running', logPath });
  run.save();
  run.report(`[run] ${result.id}; log=${logPath}`);
  const descriptor = fs.openSync(logPath, 'w');
  const started = Date.now();
  const heartbeat = setInterval(
    () => run.report(`[running] ${result.id} ${Math.round((Date.now() - started) / 1000)}s`),
    15_000,
  );
  try {
    const exitCode = await runLockedCommand(lock, run.receiptPath, command, {
      cwd,
      env: { ...process.env, AGENT_DEVICE_VALIDATION_REPORT: reportPrefix },
      signal: run.controller.signal,
      onStdoutChunk: (chunk) => {
        fs.writeSync(descriptor, chunk);
      },
      onStderrChunk: (chunk) => {
        fs.writeSync(descriptor, chunk);
      },
    });
    result.exitCode = exitCode;
    result.status = exitCode === 0 ? 'passed' : 'failed';
    run.report(`[${result.status}] ${result.id}; exit=${exitCode}`);
    if (exitCode !== 0) reportFailureTail(logPath, run.report);
    return exitCode;
  } catch (error) {
    result.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
    result.reason = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearInterval(heartbeat);
    fs.closeSync(descriptor);
    result.durationMs = Date.now() - started;
    collectTestReports(result, run.directory, reportPrefix);
    run.save();
  }
}

function reportFailureTail(logPath: string, report: (line: string) => void): void {
  const descriptor = fs.openSync(logPath, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const tail = Buffer.alloc(Math.min(size, 8000));
    fs.readSync(descriptor, tail, 0, tail.length, size - tail.length);
    report(
      tail
        .toString('utf8')
        .split('\n')
        .slice(-35)
        .map((line) => line.slice(0, 400))
        .join('\n'),
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectTestReports(result: CheckResult, directory: string, reportPrefix: string): void {
  try {
    result.testReportPaths = fs
      .readdirSync(directory)
      .filter(
        (file) => file.startsWith(path.basename(reportPrefix) + '.') && file.endsWith('.json'),
      )
      .map((file) => path.join(directory, file));
    result.tests = result.testReportPaths.map((reportPath) => {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as TestReport;
      return {
        ...report,
        failures: report.failures.slice(0, 20).map((failure) => ({
          ...failure,
          errors: failure.errors.map((error) => error.slice(0, 2000)),
        })),
        omittedFailures: Math.max(0, report.failures.length - 20),
      };
    });
  } catch (error) {
    result.testReportError = error instanceof Error ? error.message : String(error);
  }
}
