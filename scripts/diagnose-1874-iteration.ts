import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SLOW_PASS_MS = 2000;
const CADENCE_LIMIT = 40;
const SUMMARY = 'stall-summary.txt';
const EVIDENCE_DIR = '.tmp';

type MeasuredVerdict = 'passed' | 'skipped' | 'failed';

export type IterationReport = {
  readonly verdict: MeasuredVerdict | 'no-result' | 'run-failed';
  readonly keepEvidence: boolean;
  readonly lines: readonly string[];
};

export function readIteration(
  log: string,
  testName: string,
  iteration: number,
  rc: number,
): IterationReport {
  const lines = log.split('\n');
  const marker = `${testName}]' `;
  const word = lines
    .filter((line) => line.includes(marker))
    .map((line) => line.slice(line.indexOf(marker) + marker.length).split(' ')[0])
    .at(-1);
  const measured = isMeasuredVerdict(word) ? word : 'no-result';
  const exitContradictsMeasured = rc !== 0 && measured !== 'failed' && measured !== 'no-result';
  const verdict = exitContradictsMeasured ? 'run-failed' : measured;
  const durationMs = Number(
    lines
      .flatMap((line) => /phase=type-all durationMs=(\d+(?:\.\d+)?)/.exec(line)?.[1] ?? [])
      .at(-1) ?? 0,
  );
  const cadence = lines.filter((line) => line.includes('[DEBUG-1874]'));
  const keepEvidence = verdict !== 'passed' || durationMs > SLOW_PASS_MS;

  const polls = cadence.filter((line) => line.includes('] poll')).length;
  const summary = `iter=${iteration} verdict=${verdict} rc=${rc} durationMs=${durationMs} polls=${polls}`;
  const dropped = cadence.length - CADENCE_LIMIT;
  return {
    verdict,
    keepEvidence,
    lines: !keepEvidence
      ? [summary]
      : [
          summary,
          ...cadence.slice(0, CADENCE_LIMIT),
          ...(dropped > 0 ? [`… ${dropped} more DEBUG-1874 lines (full log in the artifact)`] : []),
        ],
  };
}

function isMeasuredVerdict(word: string | undefined): word is MeasuredVerdict {
  return word === 'passed' || word === 'skipped' || word === 'failed';
}

function main(): number {
  const [logPath, testName, iteration, rc] = process.argv.slice(2);
  if (!logPath || !testName || !iteration || !rc) {
    throw new Error('usage: diagnose-1874-iteration.ts <log> <testName> <iteration> <rc>');
  }
  const report = readIteration(
    fs.readFileSync(logPath, 'utf8'),
    testName,
    Number(iteration),
    Number(rc),
  );
  fs.appendFileSync(SUMMARY, `${report.lines.join('\n')}\n`);
  if (report.keepEvidence) {
    fs.copyFileSync(logPath, path.join(EVIDENCE_DIR, `stall-evidence-${iteration}.log`));
  }
  process.stdout.write(report.verdict);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
