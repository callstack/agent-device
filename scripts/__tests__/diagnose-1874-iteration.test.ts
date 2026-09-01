import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { readIteration, type IterationReport } from '../diagnose-1874-iteration.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/diagnose-1874-iteration.ts');
const WORKFLOW = path.join(root, '.github/workflows/1874-diagnose.yml');
const NAME = 'testBareTypeUsesTappedInputWhenSoftwareKeyboardIsHidden';
const POLL = '[DEBUG-1874] poll t=1ms observedLen=0 expectedPrefixLen=0';
const CADENCE = [
  '[DEBUG-1874] wait start expectedLen=17',
  POLL,
  '[DEBUG-1874] wait outcome=settled',
];

const verdictLine = (test: string, word: string) =>
  `Test Case '-[X.RunnerTests ${test}]' ${word} (1.0 seconds).`;
const phases = (typeAllMs: string) =>
  [
    `phase=focus durationMs=644.6`,
    `phase=type-all durationMs=${typeAllMs}`,
    `phase=total durationMs=7379.7`,
  ].map((phase) => `AGENT_DEVICE_RUNNER_TEXT_ENTRY_PHASE commandId=c ${phase} chars=17`);

const SHAPES: readonly (Partial<IterationReport> & { name: string; log: string[]; rc?: number })[] =
  [
    {
      name: 'healthy pass',
      log: [verdictLine(NAME, 'passed'), ...phases('796.1'), ...CADENCE],
      verdict: 'passed',
      keepEvidence: false,
      lines: ['iter=1 verdict=passed rc=0 durationMs=796.1 polls=1'],
    },
    {
      name: 'slow pass — an absorbed episode, which is the evidence #1874 wants',
      log: [verdictLine(NAME, 'passed'), ...phases('14146.4'), ...CADENCE],
      verdict: 'passed',
      keepEvidence: true,
      lines: ['iter=1 verdict=passed rc=0 durationMs=14146.4 polls=1', ...CADENCE],
    },
    {
      name: 'a pass a tenth of a millisecond over the slow threshold is still slow',
      log: [verdictLine(NAME, 'passed'), ...phases('2000.1'), ...CADENCE],
      verdict: 'passed',
      keepEvidence: true,
    },
    {
      name: 'skipped — an environment flip, not a stall',
      log: [verdictLine(NAME, 'skipped')],
      verdict: 'skipped',
      keepEvidence: true,
      lines: ['iter=1 verdict=skipped rc=0 durationMs=0 polls=0'],
    },
    {
      name: 'no verdict at all — ours to own, not the product’s',
      log: ['Executed 0 tests, with 0 failures (0 unexpected) in 0.000 seconds'],
      verdict: 'no-result',
      keepEvidence: true,
    },
    {
      name: 'a verdict word this loop does not model is not a stall either',
      log: [verdictLine(NAME, 'errored')],
      verdict: 'no-result',
    },
    {
      name: 'pair mode — the neighbour test logs first',
      log: [
        verdictLine('testBareDelayedTypeFailsWhenTappedInputDisappearsMidCommand', 'passed'),
        'AGENT_DEVICE_RUNNER_TEXT_ENTRY_PHASE commandId=n phase=type-all durationMs=5000.0 chars=17',
        verdictLine(NAME, 'passed'),
        ...phases('812.0'),
      ],
      verdict: 'passed',
      keepEvidence: false,
    },
    {
      name: 'restarted — the final word is the outcome',
      log: [verdictLine(NAME, 'failed'), ...phases('900.0'), verdictLine(NAME, 'passed')],
      verdict: 'passed',
      keepEvidence: false,
    },
    {
      name: 'measured test passed, xcodebuild did not',
      log: [verdictLine(NAME, 'passed'), ...phases('796.1'), ...CADENCE],
      rc: 65,
      verdict: 'run-failed',
      keepEvidence: true,
    },
    {
      name: 'louder than the cadence cap',
      log: [verdictLine(NAME, 'failed'), ...Array.from({ length: 45 }, () => POLL)],
      verdict: 'failed',
      keepEvidence: true,
      lines: [
        'iter=1 verdict=failed rc=0 durationMs=0 polls=45',
        ...Array.from({ length: 40 }, () => POLL),
        '… 5 more DEBUG-1874 lines (full log in the artifact)',
      ],
    },
  ];

test.each(SHAPES)('reads a $name iteration', (shape) => {
  const report = readIteration(shape.log.join('\n'), NAME, 1, shape.rc ?? 0);
  expect(report.verdict).toBe(shape.verdict);
  if (shape.keepEvidence !== undefined) expect(report.keepEvidence).toBe(shape.keepEvidence);
  if (shape.lines) expect(report.lines).toEqual(shape.lines);
});

test('the workflow forwards the exit status xcodebuild actually returned', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  expect(workflow).toContain('rc=$?');
  expect(workflow).toMatch(/diagnose-1874-iteration\.ts \\\n\s*"\$LOG" "\$TEST_NAME" "\$i" "\$rc"/);
});

test('the test name is matched literally, not as a pattern', () => {
  const log = verdictLine('testAXB', 'passed');
  expect(readIteration(log, 'testA.B', 1, 0).verdict).toBe('no-result');
  expect(readIteration(log, 'testAXB', 1, 0).verdict).toBe('passed');
});

test.each([
  { label: 'slow pass', rc: 0, verdict: 'passed' },
  { label: 'nonzero exit over a green measured test', rc: 65, verdict: 'run-failed' },
])(
  'the entry point writes, keeps evidence and prints the verdict for a $label',
  ({ rc, verdict }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-1874-'));
    try {
      fs.mkdirSync(path.join(cwd, '.tmp'));
      const log = path.join(cwd, 'iteration.log');
      fs.writeFileSync(
        log,
        [verdictLine(NAME, 'passed'), ...phases('14146.4'), ...CADENCE].join('\n'),
      );

      const printed = execFileSync(
        process.execPath,
        ['--experimental-strip-types', script, log, NAME, '7', `${rc}`],
        { cwd, encoding: 'utf8' },
      );

      expect(printed).toBe(verdict);
      expect(fs.readFileSync(path.join(cwd, 'stall-summary.txt'), 'utf8')).toBe(
        [`iter=7 verdict=${verdict} rc=${rc} durationMs=14146.4 polls=1`, ...CADENCE, ''].join(
          '\n',
        ),
      );
      expect(fs.existsSync(path.join(cwd, '.tmp', 'stall-evidence-7.log'))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
