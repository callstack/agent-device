#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = process.env.HELP_BENCH_OUT ?? join(ROOT, '.tmp', 'help-conformance-bench');
const RUN_TIMEOUT_MS = Number(process.env.HELP_BENCH_TIMEOUT_MS ?? 90_000);
const DEFAULT_RUNNERS = ['codex:gpt-5.4-mini', 'claude:claude-haiku-4-5'];
const OPTION_SPECS = {
  '--runner': { target: 'runners', mode: 'append' },
  '--runners': { target: 'runners', mode: 'csv' },
  '--case': { target: 'cases', mode: 'append' },
  '--cases': { target: 'cases', mode: 'csv' },
  '--out': { target: 'outDir', mode: 'value' },
};
const OPTION_APPLIERS = {
  append: (args, target, value) => {
    args[target] = [...(args[target] ?? []), value];
  },
  csv: (args, target, value) => {
    args[target] = [...(args[target] ?? []), ...value.split(',').filter(Boolean)];
  },
  value: (args, target, value) => {
    args[target] = value;
  },
};

const CASES = [
  {
    id: 'raw-first-screen-bluesky',
    docs: ['--help:first30'],
    task: 'Plan commands to open an already installed Bluesky app, search "callstack", open the @callstack.com account, press Follow or Following, and close.',
    expectations: ['fullPrefix', 'usesSnapshotI', 'usesSettleOnMutations', 'noWaitStable'],
  },
  {
    id: 'manual-qa-bluesky-script',
    docs: ['--help:first30', 'manual-qa'],
    task: 'You are following a manual QA script: on Bluesky, open Search, search "callstack", open @callstack.com, press Follow or Following, verify the button state changed, then close. Plan commands only.',
    expectations: [
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'verifiesNamedExpectation',
      'noWaitStable',
    ],
  },
  {
    id: 'dogfood-mode',
    docs: ['--help:first30', 'dogfood'],
    task: 'Plan a short dogfood pass for a logged-in mobile app that captures reproducible evidence for any issue found.',
    expectations: ['fullPrefix', 'usesDogfoodEvidence', 'opensAndCloses'],
  },
  {
    id: 'engineering-validate-mode',
    docs: ['--help:first30', 'validate'],
    task: 'Plan commands to validate a CLI/runtime change in agent-device against an iOS app without accidentally using stale built output.',
    expectations: ['fullPrefix', 'usesValidationPrep', 'opensAndCloses'],
  },
];

function parseArgs(argv) {
  const args = { runners: undefined, cases: undefined, dryRun: false };
  readArgs(args, argv, 0);
  applyDefaultArgs(args);
  return args;
}

function readArgs(args, argv, index) {
  if (index >= argv.length) return;
  readArgs(args, argv, readArg(args, argv, index));
}

function readArg(args, argv, index) {
  const arg = argv[index];
  if (arg === '--dry-run') return applyDryRun(args, index);
  applyOption(args, optionSpec(arg), argv[index + 1]);
  return index + 2;
}

function applyDryRun(args, index) {
  args.dryRun = true;
  return index + 1;
}

function optionSpec(arg) {
  const spec = OPTION_SPECS[arg];
  if (!spec) throw new Error(`Unknown argument: ${arg}`);
  return spec;
}

function applyOption(args, spec, value) {
  assertOptionValue(spec, value);
  OPTION_APPLIERS[spec.mode](args, spec.target, value);
}

function assertOptionValue(spec, value) {
  if (value === undefined) throw new Error(`Missing value for ${spec.target}`);
}

function applyDefaultArgs(args) {
  args.runners ??= DEFAULT_RUNNERS;
  args.cases ??= CASES.map((testCase) => testCase.id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolveOutDir(args);
  await mkdir(outDir, { recursive: true });
  const selectedCases = selectCases(args.cases);
  const docs = await loadDocs(requiredDocIds(selectedCases));

  const results = await runBenchmarkMatrix(args.runners, selectedCases, docs, outDir, args.dryRun);
  const reportPath = join(outDir, `report-${Date.now()}.json`);
  await writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Wrote ${reportPath}`);
  updateExitCode(results, args.dryRun);
}

function resolveOutDir(args) {
  return args.outDir ?? OUT_DIR;
}

function selectCases(caseIds) {
  const selectedCases = CASES.filter((testCase) => caseIds.includes(testCase.id));
  assertCasesSelected(selectedCases);
  return selectedCases;
}

function assertCasesSelected(selectedCases) {
  if (selectedCases.length === 0) throw new Error('No benchmark cases selected.');
}

function requiredDocIds(selectedCases) {
  return [...new Set(selectedCases.flatMap((testCase) => testCase.docs))];
}

function updateExitCode(results, dryRun) {
  if (!dryRun && results.some((result) => !result.passed)) process.exitCode = 1;
}

async function runBenchmarkMatrix(runners, selectedCases, docs, outDir, dryRun) {
  const results = [];
  for (const runner of runners) {
    for (const testCase of selectedCases) {
      const result = await runBenchmarkEntry(runner, testCase, docs, outDir, dryRun);
      results.push(result);
      printResult(result, dryRun);
    }
  }
  return results;
}

async function runBenchmarkEntry(runner, testCase, docs, outDir, dryRun) {
  const prompt = buildPrompt(testCase, docs);
  return dryRun
    ? { runner, caseId: testCase.id, prompt }
    : runCase(runner, testCase, prompt, outDir);
}

function printResult(result, dryRun) {
  if (dryRun) return;
  console.log(
    `${result.passed ? 'PASS' : 'FAIL'} ${result.runner} ${result.caseId} ${result.score}/${result.total}`,
  );
}

async function loadDocs(docIds) {
  return Object.fromEntries(await Promise.all(docIds.map(loadDocEntry)));
}

async function loadDocEntry(docId) {
  return [docId, await loadDoc(docId)];
}

async function loadDoc(docId) {
  if (docId === '--help:first30') return firstLines(await cliHelp(['--help']), 30);
  return cliHelp(['help', docId]);
}

async function cliHelp(args) {
  const { stdout } = await execFileAsync('node', [join(ROOT, 'bin', 'agent-device.mjs'), ...args], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout.trim();
}

function firstLines(text, count) {
  return text.split('\n').slice(0, count).join('\n');
}

function buildPrompt(testCase, docs) {
  const helpText = testCase.docs.map((docId) => `### ${docId}\n${docs[docId]}`).join('\n\n');
  return [
    'Do not run shell commands.',
    'You are evaluating agent-device CLI help. Return only JSON with keys commands and rationale.',
    'commands must be an array of command lines you would run.',
    `Task: ${testCase.task}`,
    '',
    helpText,
  ].join('\n');
}

async function runCase(runner, testCase, prompt, outDir) {
  const { raw, runnerError } = await runCaseRawOutput(runner, prompt, outDir);
  const outputPath = join(outDir, `${safeName(runner)}-${testCase.id}.txt`);
  await writeFile(outputPath, raw);
  const commands = extractCommands(raw);
  const checks = scoreExpectations(testCase.expectations, commands, raw);
  const score = countPassingChecks(checks);
  return {
    runner,
    caseId: testCase.id,
    commands,
    checks,
    score,
    total: testCase.expectations.length,
    passed: runnerError === undefined && score === testCase.expectations.length,
    ...(runnerError ? { runnerError } : {}),
    outputPath,
  };
}

async function runCaseRawOutput(runner, prompt, outDir) {
  const [kind, model] = runner.split(':');
  try {
    const raw = await runModel(kind, model, prompt, outDir);
    return {
      raw,
      runnerError: raw.trim().length === 0 ? 'Runner returned empty output.' : undefined,
    };
  } catch (error) {
    return { raw: errorOutput(error), runnerError: errorMessage(error) };
  }
}

function errorOutput(error) {
  const payload = Object(error);
  return [payload.stdout, payload.stderr].filter(Boolean).join('\n');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runModel(kind, model, prompt, outDir) {
  return kind === 'claude' ? runClaude(model, prompt) : runCodex(model, prompt, outDir);
}

async function runClaude(model, prompt) {
  const { stdout } = await execFileWithInput(
    'claude',
    [
      '-p',
      '--model',
      model,
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--output-format',
      'json',
    ],
    prompt,
    { cwd: ROOT, maxBuffer: 1024 * 1024 * 20, timeout: RUN_TIMEOUT_MS },
  );
  return stdout;
}

function execFileWithInput(file, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

async function runCodex(model, prompt, outDir) {
  const outFile = join(outDir, `codex-${model}-${Date.now()}.json`);
  const { stdout } = await execFileAsync(
    'codex',
    [
      'exec',
      '--ignore-rules',
      '--ignore-user-config',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '-m',
      model,
      '-C',
      ROOT,
      '-o',
      outFile,
      prompt,
    ],
    { cwd: ROOT, maxBuffer: 1024 * 1024 * 20, timeout: RUN_TIMEOUT_MS },
  );
  let lastMessage = '';
  try {
    lastMessage = await readFile(outFile, 'utf8');
  } catch {
    // stdout still carries the transcript when -o fails.
  }
  return `${stdout}\n${lastMessage}`;
}

function extractCommands(raw) {
  const json = parseJsonPayload(raw);
  if (json && Array.isArray(json.commands)) {
    return json.commands.map((command) => String(command).trim()).filter(Boolean);
  }
  return raw
    .split('\n')
    .map((line) => line.replace(/^[-*\d.]+\s*/, '').trim())
    .filter(
      (line) =>
        line.startsWith('agent-device ') || line.match(/^(open|snapshot|press|fill|click|close)\b/),
    );
}

function parseJsonPayload(raw) {
  const candidates = jsonPayloadCandidates(raw);
  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function jsonPayloadCandidates(raw) {
  return [raw, raw.match(/```json\s*([\s\S]*?)```/)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]].filter(
    Boolean,
  );
}

function parseJsonCandidate(candidate) {
  try {
    return normalizeParsedJson(JSON.parse(candidate));
  } catch {
    return undefined;
  }
}

function normalizeParsedJson(parsed) {
  if (typeof parsed?.result === 'string') return parseJsonPayload(parsed.result);
  return parsed;
}

const EXPECTATION_SCORERS = {
  fullPrefix: ({ commands }) =>
    commands.length > 0 &&
    commands.every(
      (command) => !/^(open|snapshot|press|fill|click|longpress|wait|close)\b/.test(command),
    ),
  usesSnapshotI: ({ commands }) => commands.some((command) => /\bsnapshot\b.*\s-i\b/.test(command)),
  usesSettleOnMutations: ({ commands }) => allMutationsUseSettle(commands),
  noWaitStable: ({ joined }) => !joined.includes('wait stable'),
  verifiesNamedExpectation: ({ joined }) => /\b(wait|is|get|find)\b/.test(joined),
  usesDogfoodEvidence: ({ joined }) =>
    /(?:\bscreenshot\b|\brecord\b|\blogs\b|\bnetwork\b|\bperf\b|\btrace\b|dogfood-output)/i.test(
      joined,
    ),
  usesValidationPrep: ({ joined }) =>
    /(?:pnpm\s+(?:build|clean:daemon|prepare)|agent-device\s+(?:doctor|prepare)\b|\bbuild:xcuitest\b)/i.test(
      joined,
    ),
  opensAndCloses: ({ joined }) => /\bopen\b/.test(joined) && /\bclose\b/.test(joined),
};

function scoreExpectations(expectations, commands, raw) {
  const context = { commands, joined: commands.join('\n').toLowerCase(), raw };
  return Object.fromEntries(
    expectations.map((expectation) => [expectation, scoreExpectation(expectation, context)]),
  );
}

function scoreExpectation(expectation, context) {
  const scorer = EXPECTATION_SCORERS[expectation];
  if (!scorer) throw new Error(`Unknown expectation: ${expectation}`);
  return scorer(context);
}

function allMutationsUseSettle(commands) {
  const mutating = commands.filter(isMutationCommand);
  return mutating.length > 0 && mutating.every((command) => command.includes('--settle'));
}

function isMutationCommand(command) {
  return /\b(press|click|fill|longpress)\b/.test(command) && !/\bsnapshot\b/.test(command);
}

function countPassingChecks(checks) {
  return Object.values(checks).filter(Boolean).length;
}

function safeName(name) {
  return basename(name).replace(/[^a-z0-9_.-]+/gi, '-');
}

await main();
