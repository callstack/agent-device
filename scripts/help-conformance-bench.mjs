#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertCaseDefinitions,
  countChecks,
  scoreExpectations,
} from './help-conformance-case-checks.mjs';
import { CASES } from './help-conformance-cases.mjs';
import { validatePlanCommands } from './help-conformance-plan-validator.mjs';
import { classifyRunnerOutput, runnerErrorOutcome } from './help-conformance-runner-output.mjs';
import { summarizeResults } from './help-conformance-summary.mjs';

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = process.env.HELP_BENCH_OUT ?? join(ROOT, '.tmp', 'help-conformance-bench');
const RUN_TIMEOUT_MS = Number(process.env.HELP_BENCH_TIMEOUT_MS ?? 90_000);
// Runner x case pairs run concurrently, capped low: these are paid LLM calls
// and the CLI help subprocess calls behind loadDocs share this same machine.
const CONCURRENCY = Number(process.env.HELP_BENCH_CONCURRENCY ?? 4);
const DEFAULT_RUNNERS = ['codex:gpt-5.4-mini', 'claude:claude-haiku-4-5'];
const USAGE = `Usage: node scripts/help-conformance-bench.mjs [options]

Feeds a help slice + task into one non-agentic LLM call per runner x case and
scores the returned command plan with production parser-backed syntax checks.

Options:
  --runner <kind:model>    Add one runner (repeatable). Default: ${DEFAULT_RUNNERS.join(', ')}
  --runners <a,b>          Comma-separated runner list
  --case <id>              Add one case id (repeatable). Default: all cases
  --cases <a,b>            Comma-separated case id list
  --repeat <n>             Run every runner x case pair n times (default: 1)
  --out <dir>              Output directory (default: .tmp/help-conformance-bench)
  --override-doc <topicId>=<path>
                           Grade a DRAFT doc: load this topic's text from the file
                           instead of the live CLI help. Repeatable; the last
                           occurrence per topic wins. Override text goes through the
                           same post-processing as the live source (e.g. the
                           --help:first30 doc id is still capped to its first 30
                           lines), so an A/B grade compares like with like.
  --dry-run                Build prompts and write the report without any LLM calls
  --help                   Show this usage text

Environment:
  HELP_BENCH_CONCURRENCY   Concurrent runner x case calls (default: 4)
  HELP_BENCH_TIMEOUT_MS    Per-call timeout (default: 90000)
  HELP_BENCH_OUT           Default output directory`;
const OPTION_SPECS = {
  '--runner': { target: 'runners', mode: 'append' },
  '--runners': { target: 'runners', mode: 'csv' },
  '--case': { target: 'cases', mode: 'append' },
  '--cases': { target: 'cases', mode: 'csv' },
  '--repeat': { target: 'repeat', mode: 'positiveInteger' },
  '--out': { target: 'outDir', mode: 'value' },
  '--override-doc': { target: 'overrideDocs', mode: 'keyvalue' },
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
  positiveInteger: (args, target, value) => {
    args[target] = parsePositiveInteger(value, `--${target}`);
  },
  keyvalue: (args, target, value) => {
    const separatorIndex = value.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`--override-doc expects <topicId>=<path>, got: ${value}`);
    }
    const topicId = value.slice(0, separatorIndex);
    const path = value.slice(separatorIndex + 1);
    const map = args[target] ?? new Map();
    map.set(topicId, path);
    args[target] = map;
  },
};

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
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
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
  if (!spec) throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
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
  args.runners = withDefault(args.runners, DEFAULT_RUNNERS);
  args.cases = withDefault(
    args.cases,
    CASES.map((testCase) => testCase.id),
  );
  args.overrideDocs = withDefault(args.overrideDocs, new Map());
  args.repeat = withDefault(args.repeat, 1);
}

function withDefault(value, fallback) {
  return value ?? fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertRuntimeConfiguration();
  assertCaseDefinitions(CASES);
  const outDir = resolveOutDir(args);
  await mkdir(outDir, { recursive: true });
  const selectedCases = selectCases(args.cases);
  const docIds = requiredDocIds(selectedCases);
  assertOverrideDocIds(args.overrideDocs, docIds);
  const docs = await loadDocs(docIds, args.overrideDocs);

  const results = await runBenchmarkMatrix(
    args.runners,
    selectedCases,
    docs,
    outDir,
    args.dryRun,
    args.repeat,
  );
  const timestamp = Date.now();
  const reportPath = join(outDir, `report-${timestamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Wrote ${reportPath}`);
  if (!args.dryRun && args.repeat > 1) {
    const summary = summarizeResults(results);
    const summaryPath = join(outDir, `summary-${timestamp}.json`);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    printSummary(summary);
    console.log(`Wrote ${summaryPath}`);
  }
  updateExitCode(results, args.dryRun);
}

function resolveOutDir(args) {
  return args.outDir ?? OUT_DIR;
}

function selectCases(caseIds) {
  const knownCaseIds = new Set(CASES.map((testCase) => testCase.id));
  const unknown = [...new Set(caseIds.filter((caseId) => !knownCaseIds.has(caseId)))];
  if (unknown.length > 0) throw new Error(`Unknown benchmark case id(s): ${unknown.join(', ')}`);
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

// A typo'd or stale --override-doc topic id must not silently grade the real
// doc while the caller believes the draft was measured: fail fast instead.
function assertOverrideDocIds(overrideDocs, docIds) {
  const unknown = [...overrideDocs.keys()].filter((topicId) => !docIds.includes(topicId));
  if (unknown.length === 0) return;
  throw new Error(
    `--override-doc topic id(s) not used by the selected cases: ${unknown.join(', ')}. Valid doc ids: ${docIds.join(', ')}.`,
  );
}

function updateExitCode(results, dryRun) {
  if (!dryRun && results.some((result) => !result.passed)) process.exitCode = 1;
}

async function runBenchmarkMatrix(runners, selectedCases, docs, outDir, dryRun, repeat) {
  const entries = runners.flatMap((runner) =>
    selectedCases.flatMap((testCase) =>
      Array.from({ length: repeat }, (_, index) => ({
        runner,
        testCase,
        trial: index + 1,
      })),
    ),
  );
  // Concurrency-capped, but results print in the original runner x case
  // matrix order (not completion order) once every entry has settled, so
  // output stays as readable as the old sequential loop.
  const results = await mapWithConcurrency(entries, CONCURRENCY, ({ runner, testCase, trial }) =>
    runBenchmarkEntry(runner, testCase, docs, outDir, dryRun, trial, repeat),
  );
  for (const result of results) printResult(result, dryRun, repeat);
  return results;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

async function runBenchmarkEntry(runner, testCase, docs, outDir, dryRun, trial, repeat) {
  const prompt = buildPrompt(testCase, docs);
  return dryRun
    ? { runner, caseId: testCase.id, trial, prompt }
    : runCase(runner, testCase, prompt, outDir, trial, repeat);
}

function printResult(result, dryRun, repeat) {
  if (dryRun) return;
  const trial = repeat > 1 ? ` trial=${result.trial}/${repeat}` : '';
  console.log(
    `${resultStatus(result)} ${result.runner} ${result.caseId}${trial} ${resultDetail(result)}`,
  );
}

function resultStatus(result) {
  if (result.runnerError) return 'ERROR';
  return result.passed ? 'PASS' : 'FAIL';
}

function resultDetail(result) {
  return result.runnerError
    ? `${result.runnerErrorReason}: ${result.runnerError}`
    : `${result.score}/${result.total}`;
}

function printSummary(summary) {
  console.log('Aggregate stability:');
  for (const group of summary) {
    const rate =
      group.passRate === null
        ? 'N/A'
        : `${group.passed}/${group.evaluatedTrials} (${Math.round(group.passRate * 100)}%)`;
    const details = summaryDetails(group);
    console.log(`  ${group.runner} ${group.caseId}: ${rate}${details ? `; ${details}` : ''}`);
  }
}

function summaryDetails(group) {
  return [
    countDetails('failed', group.failedChecks),
    countDetails('validation', group.validationIssues),
    group.runnerErrors > 0 ? `runner errors=${group.runnerErrors}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function countDetails(label, counts) {
  const entries = Object.entries(counts).map(([id, count]) => `${id}=${count}`);
  return entries.length > 0 ? `${label} ${entries.join(', ')}` : '';
}

async function loadDocs(docIds, overrideDocs) {
  return Object.fromEntries(
    await Promise.all(docIds.map((docId) => loadDocEntry(docId, overrideDocs))),
  );
}

async function loadDocEntry(docId, overrideDocs) {
  return [docId, await loadDoc(docId, overrideDocs)];
}

async function loadDoc(docId, overrideDocs) {
  // An override swaps only WHERE the text comes from; the per-doc
  // post-processing below (e.g. the --help:first30 30-line cap) applies to
  // both sources so an A/B grade compares like with like. Without this, a
  // draft longer than 30 lines would be graded on content the live path
  // always truncates away.
  return postProcessDoc(docId, await loadDocSource(docId, overrideDocs));
}

async function loadDocSource(docId, overrideDocs) {
  const overridePath = overrideDocs?.get(docId);
  if (overridePath) return readOverrideDoc(docId, overridePath);
  return docId === '--help:first30' ? cliHelp(['--help']) : cliHelp(['help', docId]);
}

async function readOverrideDoc(docId, overridePath) {
  try {
    return await readFile(overridePath, 'utf8');
  } catch (error) {
    throw new Error(
      `--override-doc file for "${docId}" is not readable: ${overridePath} (${error?.code ?? errorMessage(error)})`,
    );
  }
}

function postProcessDoc(docId, text) {
  const trimmed = text.trim();
  return docId === '--help:first30' ? firstLines(trimmed, 30) : trimmed;
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

// Only a 'success' RunnerOutcome ever reaches validatePlanCommands/
// scoreExpectations: a runner-error result carries runnerError/
// runnerErrorReason and nothing else, so infrastructure noise (an empty
// payload, a codex timeout, a Claude is_error envelope) can never masquerade
// as a model's failed command plan in the report or the aggregate summary.
async function runCase(runner, testCase, prompt, outDir, trial, repeat) {
  const outcome = await runOutcome(runner, prompt, outDir);
  const trialSuffix = repeat > 1 ? `-trial-${trial}` : '';
  const outputPath = join(outDir, `${safeName(runner)}-${testCase.id}${trialSuffix}.txt`);
  await writeFile(outputPath, outcome.raw);
  const base = { runner, caseId: testCase.id, trial, outputPath };
  if (outcome.kind === 'runner-error') {
    return {
      ...base,
      passed: false,
      runnerError: outcome.message,
      runnerErrorReason: outcome.reason,
    };
  }
  const commandValidation = await validatePlanCommands(outcome.commands, {
    allowedExternalCommands: testCase.allowedExternalCommands,
  });
  const checks = scoreExpectations(testCase, outcome.commands, outcome.raw, commandValidation);
  const score = countPassingChecks(checks);
  const total = countChecks(testCase);
  return {
    ...base,
    commands: outcome.commands,
    commandValidation,
    checks,
    score,
    total,
    passed: score === total,
  };
}

async function runOutcome(runner, prompt, outDir) {
  const [kind, model] = runner.split(':');
  try {
    const raw = await runModel(kind, model, prompt, outDir);
    return classifyRunnerOutput(raw);
  } catch (error) {
    return runnerErrorOutcome(errorOutput(error), errorMessage(error), 'process-failure');
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
  const outFile = join(
    outDir,
    `codex-${model}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  const pending = execFileAsync(
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
  // codex exec reads from stdin until EOF when it isn't a TTY. execFile never
  // closes the child's stdin pipe on its own, so without this the process
  // blocks on "Reading additional input from stdin..." until RUN_TIMEOUT_MS
  // kills it and every codex case reports empty/error output.
  pending.child?.stdin?.end();
  const { stdout } = await pending;
  let lastMessage = '';
  try {
    lastMessage = await readFile(outFile, 'utf8');
  } catch {
    // stdout still carries the transcript when -o fails.
  }
  // `-o` writes the same final JSON message that codex also prints to
  // stdout when it isn't attached to a TTY. Concatenating both produces two
  // back-to-back JSON objects, which breaks every downstream JSON.parse
  // candidate and silently zeroes out extractCommands(). Prefer the clean
  // -o payload and only fall back to stdout if it's missing/empty.
  return lastMessage.trim().length > 0 ? lastMessage : stdout;
}

function assertRuntimeConfiguration() {
  parsePositiveInteger(String(CONCURRENCY), 'HELP_BENCH_CONCURRENCY');
  parsePositiveInteger(String(RUN_TIMEOUT_MS), 'HELP_BENCH_TIMEOUT_MS');
}

function countPassingChecks(checks) {
  return Object.values(checks).filter(Boolean).length;
}

function safeName(name) {
  return basename(name).replace(/[^a-z0-9_.-]+/gi, '-');
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} expects a positive integer, got: ${value}`);
  }
  return parsed;
}

// Expected failures (bad flags, unreadable override files, unknown topic ids)
// print as one clean line instead of an unhandled stack trace.
try {
  await main();
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
