#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = process.env.HELP_BENCH_OUT ?? join(ROOT, '.tmp', 'help-conformance-bench');
const RUN_TIMEOUT_MS = Number(process.env.HELP_BENCH_TIMEOUT_MS ?? 90_000);
// Runner x case pairs run concurrently, capped low: these are paid LLM calls
// and the CLI help subprocess calls behind loadDocs share this same machine.
const CONCURRENCY = Number(process.env.HELP_BENCH_CONCURRENCY ?? 4);
const DEFAULT_RUNNERS = ['codex:gpt-5.4-mini', 'claude:claude-haiku-4-5'];
const USAGE = `Usage: node scripts/help-conformance-bench.mjs [options]

Feeds a help slice + task into one non-agentic LLM call per runner x case and
regex-scores the returned command plan.

Options:
  --runner <kind:model>    Add one runner (repeatable). Default: ${DEFAULT_RUNNERS.join(', ')}
  --runners <a,b>          Comma-separated runner list
  --case <id>              Add one case id (repeatable). Default: all cases
  --cases <a,b>            Comma-separated case id list
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

// Raw-coordinate fallback the ported skillgym quiz cases forbid: a
// click/fill/press targeting bare numbers instead of a ref or selector.
const RAW_COORDINATE_TARGET =
  /(?:^|\n)(?:agent-device\s+)?(?:click|fill|press)\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/i;

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
  // The three cases below are ported from
  // test/skillgym/suites/agent-device-smoke-suite.ts (settle-diff-is-observation,
  // sample-output-settled-diff-next-target, sample-output-not-settled-needs-observe).
  // They are self-contained "next-command quiz" cases: a captured agent-device
  // output plus a task, scored by regex instead of the named expectation
  // scorers above. Output text mirrors the CURRENT settle rendering in
  // src/commands/interaction/output.ts, including the "unchanged interactive
  // (N):" tail added by #1167/#1172 for diffs with no meaningful added ref.
  {
    id: 'settle-diff-is-observation',
    docs: ['--help:first30'],
    task: `You already ran this command and observed its settled output:

agent-device press @e37 --settle
Tapped @e37 (203, 88)
settled after 540ms: +0 -1 (~15 unchanged)
- @e50 [text] "Suggested for you"
unchanged interactive (4):
= @e64 [text-field] "Search"
= @e65 [text] "Recent searches"
= @e12 [tab] "Home"
= @e40 [tab] "Profile"

The task was to confirm the feed-search UI is present, then close the session. The settled diff and its unchanged-interactive tail above already contain every ref and piece of evidence the task needs: the Search field and Recent searches are both listed. Plan only the next command. Do not take another snapshot, wait, find, get, or is call just to re-read evidence that is already shown above.`,
    expectations: ['fullPrefix'],
    matchers: [{ id: 'plansClose', pattern: /(?:^|\n)(?:agent-device\s+)?close\b/i }],
    forbidden: [
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noWait', pattern: /\bwait\b/i },
      { id: 'noFind', pattern: /\bfind\b/i },
      { id: 'noGet', pattern: /\bget\b/i },
      { id: 'noIs', pattern: /\bis\b/i },
      { id: 'noPressOrClick', pattern: /\b(?:press|click)\b/i },
    ],
  },
  {
    id: 'sample-output-settled-diff-next-target',
    docs: ['--help:first30'],
    task: `Read this previous agent-device output, then plan the next command:

agent-device fill 'id="account-search"' "callstack" --settle
Filled 9 chars
settled after 610ms: +2 -0 (~18 unchanged)
+ @e64 [button] "@callstack.com"
+ @e65 [text] "Callstack"

Use the ref exposed by the settled diff to open the account, with --settle on this next action too. Do not re-read the same screen first.`,
    expectations: ['fullPrefix'],
    matchers: [
      { id: 'pressOrClickOrTap', pattern: /\b(?:press|click|tap)\b/i },
      { id: 'usesE64RefOrLabel', pattern: /@e64\b|label=(?:["']?@callstack\.com["']?)/i },
      { id: 'usesSettleFlag', pattern: /--settle\b/i },
    ],
    forbidden: [
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noWaitStable', pattern: /wait\s+stable/i },
      { id: 'noFill', pattern: /\bfill\b/i },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-not-settled-needs-observe',
    docs: ['--help:first30'],
    task: `Read this previous agent-device output, then plan the next command:

agent-device press @e12 --settle
Tapped @e12 (166, 240)
not settled after 10000ms
hint: The UI kept changing for the whole settle budget (animation, carousel, or ticker?), so no settled diff is shown. Raise --timeout, wait for specific content, or take a fresh snapshot.

Old refs may be stale after this mutation, and no settled diff was printed, so the next target is unknown. Follow the output hint: observe the current UI (a fresh snapshot or a wait) before attempting another ref-based action.`,
    expectations: ['fullPrefix'],
    matchers: [
      {
        id: 'observesBeforeActing',
        pattern: /(?:^|\n)(?:agent-device\s+)?(?:wait\b|snapshot\b[^\n]*-i\b)/i,
      },
    ],
    forbidden: [
      {
        id: 'noBareRefMutation',
        pattern: /(?:^|\n)(?:agent-device\s+)?(?:press|click|fill|longpress)\s+@e\d+/i,
      },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
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
  args.runners ??= DEFAULT_RUNNERS;
  args.cases ??= CASES.map((testCase) => testCase.id);
  args.overrideDocs ??= new Map();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolveOutDir(args);
  await mkdir(outDir, { recursive: true });
  const selectedCases = selectCases(args.cases);
  const docIds = requiredDocIds(selectedCases);
  assertOverrideDocIds(args.overrideDocs, docIds);
  const docs = await loadDocs(docIds, args.overrideDocs);

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

async function runBenchmarkMatrix(runners, selectedCases, docs, outDir, dryRun) {
  const entries = runners.flatMap((runner) =>
    selectedCases.map((testCase) => ({ runner, testCase })),
  );
  // Concurrency-capped, but results print in the original runner x case
  // matrix order (not completion order) once every entry has settled, so
  // output stays as readable as the old sequential loop.
  const results = await mapWithConcurrency(entries, CONCURRENCY, ({ runner, testCase }) =>
    runBenchmarkEntry(runner, testCase, docs, outDir, dryRun),
  );
  for (const result of results) printResult(result, dryRun);
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

async function runCase(runner, testCase, prompt, outDir) {
  const { raw, runnerError } = await runCaseRawOutput(runner, prompt, outDir);
  const outputPath = join(outDir, `${safeName(runner)}-${testCase.id}.txt`);
  await writeFile(outputPath, raw);
  const commands = extractCommands(raw);
  const checks = scoreExpectations(testCase, commands, raw);
  const score = countPassingChecks(checks);
  const total = countChecks(testCase);
  return {
    runner,
    caseId: testCase.id,
    commands,
    checks,
    score,
    total,
    passed: runnerError === undefined && score === total,
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

/**
 * Every check a case declares, normalized to a uniform `{ id, test }` shape:
 * - `expectations`: named lookups into EXPECTATION_SCORERS (the original 4
 *   help-layout cases).
 * - `matchers`: the check passes when the pattern matches the planned
 *   commands (ported skillgym quiz cases' `outputs`).
 * - `forbidden`: the check passes when the pattern does NOT match (ported
 *   skillgym quiz cases' `forbiddenOutputs`).
 */
function resolveChecks(testCase) {
  const named = (testCase.expectations ?? []).map((id) => ({
    id,
    test: (context) => scoreExpectation(id, context),
  }));
  const matched = (testCase.matchers ?? []).map(({ id, pattern }) => ({
    id,
    test: (context) => pattern.test(context.joined),
  }));
  const forbidden = (testCase.forbidden ?? []).map(({ id, pattern }) => ({
    id,
    test: (context) => !pattern.test(context.joined),
  }));
  return [...named, ...matched, ...forbidden];
}

function countChecks(testCase) {
  return resolveChecks(testCase).length;
}

function scoreExpectations(testCase, commands, raw) {
  const context = { commands, joined: commands.join('\n').toLowerCase(), raw };
  return Object.fromEntries(resolveChecks(testCase).map(({ id, test }) => [id, test(context)]));
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

// Expected failures (bad flags, unreadable override files, unknown topic ids)
// print as one clean line instead of an unhandled stack trace.
try {
  await main();
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
