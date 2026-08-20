import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { scoreExpectations } from '../help-conformance-case-checks.mjs';
import { validateAgentDeviceCommand } from '../help-conformance-command-validator.ts';
import { opensAndCloses, usesValidationPrep } from '../help-conformance-expectations.mjs';
import { validatePlanCommands } from '../help-conformance-plan-validator.mjs';
import { classifyRunnerOutput, extractCommands } from '../help-conformance-runner-output.mjs';
import { summarizeResults } from '../help-conformance-summary.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', 'help-conformance-bench.mjs');
const AGENT_DEVICE_SKILL = join(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  'agent-device',
  'SKILL.md',
);

// These tests spawn the real script in --dry-run mode with every required doc
// overridden, so no LLM call and no built CLI is needed: the raw-first-screen
// case's only doc is --help:first30, and the override replaces the shell-out.

async function runBench(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const payload = error as { code?: number; stdout?: string; stderr?: string };
    return { code: payload.code ?? 1, stdout: payload.stdout ?? '', stderr: payload.stderr ?? '' };
  }
}

async function readDryRunReport(
  outDir: string,
): Promise<Array<{ prompt: string; runner: string; caseId: string; trial: number }>> {
  const reportName = (await readdir(outDir)).find((name) => name.startsWith('report-'));
  assert.ok(reportName, 'dry-run must write a report file');
  const report = JSON.parse(await readFile(join(outDir, reportName), 'utf8'));
  assert.ok(report.length > 0 && typeof report[0]?.prompt === 'string');
  return report;
}

async function readDryRunPrompts(outDir: string): Promise<string[]> {
  return (await readDryRunReport(outDir)).map(({ prompt }) => prompt);
}

async function readDryRunPrompt(outDir: string): Promise<string> {
  return (await readDryRunPrompts(outDir))[0]!;
}

// Guards the --override-doc contract: an override swaps only WHERE the doc
// text comes from, never how it is sliced. The --help:first30 doc id caps the
// live `--help` output at 30 lines, so an override longer than that must be
// capped identically or the A/B comparison grades content a live run never
// shows (the exact bug found in review of the initial version).
test('override for --help:first30 goes through the same 30-line cap as the live doc', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'draft-help.txt');
  const lines = Array.from({ length: 49 }, (_, i) => `draft help line ${i + 1}`);
  await writeFile(draftPath, lines.join('\n'));
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--runner',
    'claude:test-model',
    '--override-doc',
    `--help:first30=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const prompt = await readDryRunPrompt(dir);
  assert.ok(prompt.includes('draft help line 30'), 'line 30 is inside the cap and must survive');
  assert.ok(!prompt.includes('draft help line 31'), 'line 31 is past the cap and must be cut');
});

test('an override topic id no selected case uses fails fast and lists valid doc ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'draft.txt');
  await writeFile(draftPath, 'irrelevant');
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--override-doc',
    `totally-bogus-topic=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /totally-bogus-topic/);
  assert.match(run.stderr, /Valid doc ids: --help:first30/);
  assert.equal(
    (await readdir(dir)).some((name) => name.startsWith('report-')),
    false,
  );
});

test('a missing override file reports one clean error line, not a stack trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--override-doc',
    `--help:first30=${join(dir, 'does-not-exist.txt')}`,
    '--out',
    dir,
  ]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /--override-doc file for "--help:first30" is not readable/);
  assert.doesNotMatch(run.stderr, /at .*help-conformance-bench\.mjs/);
});

test('repeated overrides for the same topic id are last-wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const firstPath = join(dir, 'first.txt');
  const secondPath = join(dir, 'second.txt');
  await writeFile(firstPath, 'first draft body');
  await writeFile(secondPath, 'second draft body');
  const run = await runBench([
    '--dry-run',
    '--case',
    'raw-first-screen-bluesky',
    '--runner',
    'claude:test-model',
    '--override-doc',
    `--help:first30=${firstPath}`,
    '--override-doc',
    `--help:first30=${secondPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const prompt = await readDryRunPrompt(dir);
  assert.ok(prompt.includes('second draft body'));
  assert.ok(!prompt.includes('first draft body'));
});

test('--repeat expands each runner x case pair into numbered independent trials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'first-screen.txt');
  await writeFile(draftPath, 'minimal first-screen help');
  const run = await runBench([
    '--dry-run',
    '--case',
    'metamorphic-community-search',
    '--runner',
    'claude:test-model',
    '--repeat',
    '3',
    '--override-doc',
    `--help:first30=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const report = await readDryRunReport(dir);
  assert.deepEqual(
    report.map(({ runner, caseId, trial }) => ({ runner, caseId, trial })),
    [1, 2, 3].map((trial) => ({
      runner: 'claude:test-model',
      caseId: 'metamorphic-community-search',
      trial,
    })),
  );
});

test('invalid repeat counts and mixed known/unknown case ids fail before a report is written', async () => {
  for (const args of [
    ['--repeat', '0', '--case', 'raw-first-screen-bluesky'],
    ['--repeat', 'many', '--case', 'raw-first-screen-bluesky'],
    ['--cases', 'raw-first-screen-bluesky,typo-case'],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
    const run = await runBench(['--dry-run', ...args, '--out', dir]);
    assert.notEqual(run.code, 0);
    assert.equal(
      (await readdir(dir)).some((name) => name.startsWith('report-')),
      false,
    );
  }
});

test('metamorphic case changes domain nouns without leaking the original benchmark answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'first-screen.txt');
  await writeFile(draftPath, 'minimal first-screen help');
  const run = await runBench([
    '--dry-run',
    '--case',
    'metamorphic-community-search',
    '--runner',
    'claude:test-model',
    '--override-doc',
    `--help:first30=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const prompt = await readDryRunPrompt(dir);
  assert.match(prompt, /com\.example\.community/);
  assert.match(prompt, /@react\.dev/);
  assert.doesNotMatch(prompt, /bluesky|callstack|@e64/i);
});

test('runtime-output cases do not coach the command that their output should imply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-bench-'));
  const draftPath = join(dir, 'first-screen.txt');
  await writeFile(draftPath, 'minimal first-screen help');
  const run = await runBench([
    '--dry-run',
    '--cases',
    [
      'settle-diff-is-observation',
      'sample-output-settled-diff-next-target',
      'metamorphic-settled-diff-next-target-notes',
      'sample-output-not-settled-needs-observe',
      'sample-output-device-in-use-reuses-session',
      'sample-output-stale-ref-resnapshots',
      'sample-output-ambiguous-match-reobserves',
      'sample-output-app-not-installed-discovers-first',
    ].join(','),
    '--runner',
    'claude:test-model',
    '--override-doc',
    `--help:first30=${draftPath}`,
    '--out',
    dir,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const prompts = (await readDryRunPrompts(dir)).join('\n');
  assert.doesNotMatch(prompts, /Do not take another snapshot/i);
  assert.doesNotMatch(prompts, /Use the ref exposed by the settled diff/i);
  assert.doesNotMatch(prompts, /Follow the output hint/i);
  assert.doesNotMatch(prompts, /Retry the same target/i);
});

test('command validator accepts production flags and interaction grammar', () => {
  assert.deepEqual(validateAgentDeviceCommand(['--version']), { valid: true });
  assert.deepEqual(validateAgentDeviceCommand(['fill', 'label=Search', 'callstack', '--settle']), {
    valid: true,
  });
  assert.deepEqual(
    validateAgentDeviceCommand(['fill', 'label=Search', '@callstack.com', '--settle']),
    { valid: true },
  );
  assert.deepEqual(validateAgentDeviceCommand(['is', 'visible', 'label=Following']), {
    valid: true,
  });
});

test('command validator rejects unsupported flags and malformed interaction grammar', () => {
  for (const argv of [
    ['close', '--settle'],
    ['wait', '--selector', 'role=button'],
    ['press', 'key=Enter', '--settle'],
    ['is', 'role=button', 'label=Following'],
  ]) {
    const result = validateAgentDeviceCommand(argv);
    assert.equal(result.valid, false, `${argv.join(' ')} should fail`);
    assert.ok(result.error);
  }
});

test('command validator rejects pseudo refs and excess production-schema positionals', () => {
  for (const argv of [
    ['press', '@<search-ref>', '--settle'],
    ['fill', '@search_field', 'callstack', '--settle'],
    ['get', 'text', '@search-field'],
    ['focus', '@search-field', '10'],
    ['scroll', '@down'],
    ['snapshot', '-i', './evidence.json'],
    ['open', 'com.example.community', 'https://example.com', 'close'],
    ['close', 'first-app', 'second-app'],
  ]) {
    const result = validateAgentDeviceCommand(argv);
    assert.equal(result.valid, false, `${argv.join(' ')} should fail`);
    assert.ok(result.error);
  }
});

test('open and close scoring requires separate top-level commands', () => {
  assert.equal(
    opensAndCloses({
      commands: ['agent-device open com.example.community close'],
    }),
    false,
  );
  assert.equal(
    opensAndCloses({
      commands: ['agent-device open com.example.community', 'agent-device close'],
    }),
    true,
  );
});

test('validation prep accepts intervening checks and the Android build path in order', () => {
  assert.equal(
    usesValidationPrep({
      commands: ['agent-device doctor', 'pnpm build', 'pnpm clean:daemon'],
    }),
    true,
  );
  assert.equal(
    usesValidationPrep({
      commands: ['pnpm run build:android', 'agent-device doctor', 'pnpm clean:daemon'],
    }),
    true,
  );
  assert.equal(
    usesValidationPrep({
      commands: ['pnpm clean:daemon', 'pnpm build'],
    }),
    false,
  );
});

test('runner output classifies model commands as success and infrastructure noise as runner-error', () => {
  const successEnvelope = JSON.stringify({
    is_error: false,
    result: JSON.stringify({ commands: ['agent-device snapshot -i'] }),
  });
  assert.deepEqual(extractCommands(successEnvelope), ['agent-device snapshot -i']);
  assert.deepEqual(classifyRunnerOutput(successEnvelope), {
    kind: 'success',
    raw: successEnvelope,
    commands: ['agent-device snapshot -i'],
  });

  const claudeError = JSON.stringify({
    is_error: true,
    result: 'API Error: Unable to connect to API',
  });
  assert.deepEqual(classifyRunnerOutput(claudeError), {
    kind: 'runner-error',
    raw: claudeError,
    message: 'API Error: Unable to connect to API',
    reason: 'error-envelope',
  });
  assert.deepEqual(extractCommands(claudeError), []);

  const rateLimited = JSON.stringify({ type: 'error', message: 'rate limit exceeded' });
  assert.deepEqual(classifyRunnerOutput(rateLimited), {
    kind: 'runner-error',
    raw: rateLimited,
    message: 'rate limit exceeded',
    reason: 'error-envelope',
  });

  // status: 'failed' alone does not shadow a real commands payload.
  const statusFailedWithCommands = JSON.stringify({
    status: 'failed',
    commands: ['agent-device snapshot -i'],
  });
  assert.equal(classifyRunnerOutput(statusFailedWithCommands).kind, 'success');

  const empty = classifyRunnerOutput('');
  assert.deepEqual(empty, {
    kind: 'runner-error',
    raw: '',
    message: 'Runner returned empty output.',
    reason: 'empty-output',
  });
});

test('plan validator rejects shell projection and non-permitted executables', async () => {
  const [redirected, piped, newline, carriageReturn, escapedNewline, shellCommand] =
    await validatePlanCommands([
      'agent-device snapshot -i > evidence.json',
      'agent-device snapshot -i | tee evidence.txt',
      'agent-device press @e1 --settle\ncat',
      'agent-device press @e1 --settle\rcat',
      'agent-device press @e1 --settle\\\ncat',
      'echo done',
    ]);
  for (const result of [redirected, piped, newline, carriageReturn, escapedNewline]) {
    assert.equal(result.issues[0]?.kind, 'shell-projection');
  }
  assert.equal(shellCommand.issues[0]?.kind, 'executable-policy');

  const [quotedNewline] = await validatePlanCommands([
    'agent-device fill label=Biography "line one\nline two" --settle',
  ]);
  assert.equal(quotedNewline.issues.length, 0);
  assert.deepEqual(quotedNewline.tokens, [
    'agent-device',
    'fill',
    'label=Biography',
    'line one\nline two',
    '--settle',
  ]);

  const [placeholder] = await validatePlanCommands(['agent-device press @<search-ref> --settle']);
  assert.ok(placeholder.issues.some(({ kind }) => kind === 'pseudo-ref'));
  assert.ok(placeholder.issues.some(({ kind }) => kind === 'shell-projection'));
});

// The compact workflow card teaches chaining confident consecutive steps
// with an unquoted `&&`. This is the validator side of that contract: split
// on `&&` and validate each chained segment as its own agent-device command,
// instead of failing the whole line as one shell-projection violation.
test('plan validator splits an unquoted && chain into independently valid segments', async () => {
  const [press, fill] = await validatePlanCommands([
    'agent-device press \'label="Search"\' --settle && agent-device fill \'label="Search"\' "query" --settle',
  ]);
  assert.equal(press.issues.length, 0);
  assert.deepEqual(press.tokens, ['agent-device', 'press', 'label="Search"', '--settle']);
  assert.equal(fill.issues.length, 0);
  assert.deepEqual(fill.tokens, ['agent-device', 'fill', 'label="Search"', 'query', '--settle']);
});

test('plan validator fails only the offending segment of a chained plan', async () => {
  const [goodFirst, badSecond] = await validatePlanCommands([
    'agent-device snapshot -i && agent-device press @<search-ref> --settle',
  ]);
  assert.equal(goodFirst.issues.length, 0);
  assert.ok(badSecond.issues.some(({ kind }) => kind === 'pseudo-ref'));
});

test('plan validator does not split && inside a quoted selector value', async () => {
  const [single] = await validatePlanCommands([
    'agent-device fill \'label="A && B"\' "value" --settle',
  ]);
  assert.equal(single.issues.length, 0);
  assert.deepEqual(single.tokens, ['agent-device', 'fill', 'label="A && B"', 'value', '--settle']);
});

test('plan validator still rejects an unquoted lone & as a shell operator', async () => {
  const [lone] = await validatePlanCommands(['agent-device open foo & agent-device close']);
  assert.equal(lone.issues[0]?.kind, 'shell-projection');
});

test('plan validator keeps single-command results identical when no chain is present', async () => {
  const [single] = await validatePlanCommands(['agent-device snapshot -i']);
  assert.equal(single.issues.length, 0);
  assert.deepEqual(single.tokens, ['agent-device', 'snapshot', '-i']);
  assert.equal(single.command, 'agent-device snapshot -i');
});

// A real shell rejects && with an empty operand on either side. A validator
// that silently dropped the empty segment (instead of failing it) would
// bless a plan that fails at execution — exactly the gap review found.
test('plan validator rejects a leading && as an empty chain operand', async () => {
  const [empty, closeSegment] = await validatePlanCommands(['&& agent-device close']);
  assert.equal(empty.issues[0]?.kind, 'empty-chain-operand');
  assert.equal(closeSegment.issues.length, 0);
});

test('plan validator rejects a trailing && as an empty chain operand', async () => {
  const [pressSegment, empty] = await validatePlanCommands(['agent-device press @e1 --settle &&']);
  assert.equal(pressSegment.issues.length, 0);
  assert.equal(empty.issues[0]?.kind, 'empty-chain-operand');
});

test('plan validator rejects a doubled && as an empty chain operand', async () => {
  const [openSegment, empty, closeSegment] = await validatePlanCommands([
    'agent-device open foo && && agent-device close',
  ]);
  assert.equal(openSegment.issues.length, 0);
  assert.equal(empty.issues[0]?.kind, 'empty-chain-operand');
  assert.equal(closeSegment.issues.length, 0);
});

test('plan validator still allows a quoted && to pass through a single segment unsplit', async () => {
  const [single] = await validatePlanCommands([
    'agent-device fill \'label="A && B"\' "value" --settle',
  ]);
  assert.equal(single.issues.length, 0);
  assert.deepEqual(single.tokens, ['agent-device', 'fill', 'label="A && B"', 'value', '--settle']);
});

test('case matchers score parsed tokens so shell quoting does not change results', async () => {
  const commands = [
    'agent-device open "com.example.shop"',
    `agent-device fill 'label=Search' "react native" --settle`,
    'agent-device press label="@react.dev" --settle',
    `agent-device open 'settings'`,
  ];
  const commandValidation = await validatePlanCommands(commands);
  const checks = scoreExpectations(
    {
      matchers: [
        {
          id: 'opensKnownDogfoodApp',
          pattern: /\bagent-device\s+open\s+com\.example\.shop\b/i,
        },
        {
          id: 'fillsExpectedSearch',
          pattern:
            /\bagent-device\s+fill\b[^\n]*(?:"react native"|'react native')[^\n]*--settle\b/i,
        },
        {
          id: 'usesLiteralHandleSelector',
          pattern:
            /\bagent-device\s+(?:press|click|tap)\b[^\n]*(?:label|text)=@react\.dev\b[^\n]*--settle\b/i,
        },
        {
          id: 'opensSettings',
          pattern: /\bagent-device\s+open\s+(?:settings|com\.apple\.Preferences)\b/i,
        },
      ],
    },
    commands,
    '',
    commandValidation,
  );
  assert.deepEqual(checks, {
    opensKnownDogfoodApp: true,
    fillsExpectedSearch: true,
    usesLiteralHandleSelector: true,
    opensSettings: true,
  });
});

test('foreground attach grammar accepts both auto-discovery and an explicit known app', async () => {
  const autoDiscoveryCommand = 'agent-device open --foreground --platform ios';
  const explicitTargetCommand = 'agent-device open --foreground --platform ios com.example.app';
  const [autoDiscovery, explicitTarget] = await validatePlanCommands([
    autoDiscoveryCommand,
    explicitTargetCommand,
  ]);

  assert.deepEqual(autoDiscovery.agentCommand, { command: 'open', positionals: [] });
  assert.deepEqual(explicitTarget.agentCommand, {
    command: 'open',
    positionals: ['com.example.app'],
  });
  assert.deepEqual(autoDiscovery.issues, []);
  assert.deepEqual(explicitTarget.issues, []);
});

test('compact skill starts a known-app task with foreground open and an initial snapshot', async () => {
  const skill = await readFile(AGENT_DEVICE_SKILL, 'utf8');
  const openingCommands = skill
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('agent-device open <app>'));

  assert.ok(
    skill.split('\n').length <= 30,
    'the complete skill must fit the reliable first-30-line read',
  );
  assert.deepEqual(openingCommands, ['agent-device open <app> --foreground']);
  assert.match(skill, /returns the initial interactive snapshot with `@refs`/);
  assert.match(
    skill,
    /copy refs? byte-for-byte.*keep the `@`/i,
    'the always-loaded skill must preserve the @ prefix before topic help is available',
  );
  assert.match(skill, /sparse\/AX-unavailable.*refs and selectors are invalid/i);
  assert.match(skill, /`agent-device screenshot`.*use coordinates.*`snapshot -i`/i);
});

test('plan validator applies narrow grammar to permitted external commands', async () => {
  const results = await validatePlanCommands(
    [
      'mkdir -p dogfood-output',
      'mkdir dogfood-output',
      'pnpm build',
      'pnpm run build:android',
      'pnpm clean:daemon --prune-dev',
      'pnpm test',
    ],
    { allowedExternalCommands: ['mkdir', 'pnpm'] },
  );
  assert.equal(results[0].issues.length, 0);
  assert.equal(results[1].issues[0]?.kind, 'external-command-grammar');
  assert.equal(results[2].issues.length, 0);
  assert.equal(results[3].issues.length, 0);
  assert.equal(results[4].issues.length, 0);
  assert.equal(results[5].issues[0]?.kind, 'external-command-grammar');
});

test('plan validator strips shell comments without mutating command arguments', async () => {
  const [snapshot, press] = await validatePlanCommands([
    'agent-device snapshot -i # capture evidence',
    'agent-device press @e64 --settle # tap result',
  ]);
  assert.equal(snapshot.issues.length, 0);
  assert.deepEqual(snapshot.tokens, ['agent-device', 'snapshot', '-i']);
  assert.equal(press.issues.length, 0);
  assert.deepEqual(press.tokens, ['agent-device', 'press', '@e64', '--settle']);
});

test('plan validator keeps agent result alignment across skipped and external lines', async () => {
  const results = await validatePlanCommands(
    [
      'agent-device snapshot -i > evidence.json',
      'mkdir -p evidence',
      'agent-device snapshot -i',
      'pnpm build',
      'agent-device get text @search-field',
    ],
    { allowedExternalCommands: ['mkdir', 'pnpm'] },
  );
  assert.equal(results[0].issues[0]?.kind, 'shell-projection');
  assert.equal(results[1].issues.length, 0);
  assert.equal(results[2].issues.length, 0);
  assert.equal(results[3].issues.length, 0);
  assert.equal(results[4].issues[0]?.kind, 'pseudo-ref');
});

test('aggregate summary exposes stability and failure taxonomy per runner x case', () => {
  const summary = summarizeResults([
    {
      runner: 'claude:haiku',
      caseId: 'metamorphic',
      passed: true,
      checks: { validPlanCommands: true, usesSettle: true },
      commandValidation: [],
    },
    // A runner-error result (see runCase in help-conformance-bench.mjs)
    // never carries checks/commandValidation alongside runnerError: an
    // infrastructure failure must not also read as a model validation
    // failure in the aggregate taxonomy.
    {
      runner: 'claude:haiku',
      caseId: 'metamorphic',
      passed: false,
      runnerError: 'failed',
      runnerErrorReason: 'process-failure',
    },
    {
      runner: 'claude:haiku',
      caseId: 'metamorphic',
      passed: false,
      checks: { validPlanCommands: false, usesSettle: true },
      commandValidation: [
        {
          issues: [{ kind: 'pseudo-ref', error: 'bad ref' }],
        },
      ],
    },
  ]);
  assert.deepEqual(summary, [
    {
      runner: 'claude:haiku',
      caseId: 'metamorphic',
      trials: 3,
      evaluatedTrials: 2,
      passed: 1,
      failedChecks: { validPlanCommands: 1 },
      validationIssues: { 'pseudo-ref': 1 },
      runnerErrors: 1,
      passRate: 0.5,
    },
  ]);
});

test('a group with only runner-error trials reports passRate: null, not 0/0', () => {
  const summary = summarizeResults([
    {
      runner: 'codex:gpt',
      caseId: 'metamorphic',
      passed: false,
      runnerError: 'timed out',
      runnerErrorReason: 'process-failure',
    },
    {
      runner: 'codex:gpt',
      caseId: 'metamorphic',
      passed: false,
      runnerError: 'Runner returned empty output.',
      runnerErrorReason: 'empty-output',
    },
  ]);
  assert.deepEqual(summary, [
    {
      runner: 'codex:gpt',
      caseId: 'metamorphic',
      trials: 2,
      evaluatedTrials: 0,
      passed: 0,
      failedChecks: {},
      validationIssues: {},
      runnerErrors: 2,
      passRate: null,
    },
  ]);
});
