#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const COMMENT_MARKER = '<!-- agent-device-size-report -->';
// This run's identity as a base-worktree lock owner: pid for liveness, nonce against pid reuse.
const LOCK_IDENTITY = `${process.pid}:${crypto.randomUUID()}`;
const GITHUB_REQUEST_ATTEMPTS = 4;
// Overridable so the regression tests do not sleep through real backoff.
const GITHUB_RETRY_BASE_MS = Number(process.env.SIZE_REPORT_RETRY_BASE_MS ?? 1000);
class TransientGitHubError extends Error {}
const VALUE_ARGS = new Map([
  ['--cwd', 'cwd'],
  ['--json', 'json'],
  ['--markdown', 'markdown'],
  ['--compare', 'compare'],
  ['--base', 'base'],
  ['--post-comment', 'postComment'],
  ['--pr', 'pr'],
  ['--startup-runs', 'startupRuns'],
]);

const STARTUP_BENCHMARKS = [
  { name: 'CLI --version', args: ['--version'] },
  { name: 'CLI --help', args: ['--help'] },
];

const args = parseArgs(process.argv.slice(2));
const cwd = path.resolve(args.cwd ?? process.cwd());

if (args.postComment) {
  await postGitHubCommentBestEffort(args.postComment, args.pr);
  process.exit(0);
}

if (args.compare && args.base) {
  throw new Error(
    '--compare and --base are exclusive: one supplies the base report, the other measures it',
  );
}
const startupRuns = parseNonNegativeInteger(args.startupRuns ?? '0', '--startup-runs');
const report = collectReport(cwd, { startupRuns });
const baseReport = args.compare
  ? JSON.parse(fs.readFileSync(args.compare, 'utf8'))
  : args.base
    ? measureBaseRef(cwd, args.base, { startupRuns })
    : null;

if (args.json) {
  writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
}

const markdown = formatMarkdown(report, baseReport, args.base);

if (args.markdown) {
  writeFile(args.markdown, markdown);
} else {
  process.stdout.write(markdown);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (assignValueArg(parsed, arg, argv, index)) index += 1;
    else if (isHelpArg(arg)) printHelpAndExit();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function assignValueArg(parsed, arg, argv, index) {
  const key = VALUE_ARGS.get(arg);
  if (!key) return false;
  parsed[key] = readValue(argv, index + 1, arg);
  return true;
}

function isHelpArg(arg) {
  return arg === '--help' || arg === '-h';
}

function printHelpAndExit() {
  process.stdout.write(`Usage: node scripts/size-report.mjs [options]

Options:
  --cwd <path>             Project root to measure. Defaults to cwd.
  --json <path>            Write the raw size report JSON.
  --markdown <path>        Write the markdown report.
  --compare <path>         Compare against a previously written JSON report.
  --base <ref>             Measure <ref> (e.g. origin/main) in a detached worktree under
                           .tmp/size-base/ and compare against it: the local one-command
                           equivalent of the Size workflow's base/PR comparison.
  --startup-runs <count>   Measure startup medians for side-effect-free CLI commands.
  --post-comment <path>    Post or update the markdown report on the current PR.
  --pr <number>            Pull request number for --post-comment.
`);
  process.exit(0);
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function collectReport(root, options) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const jsFiles = walk(path.join(root, 'dist', 'src')).filter((file) => file.endsWith('.js'));
  if (jsFiles.length === 0) {
    throw new Error('No dist/src JavaScript files found. Run `pnpm build` before measuring size.');
  }
  prepareGeneratedPackageAssets(root);

  const chunks = jsFiles
    .map((file) => {
      const buffer = fs.readFileSync(file);
      return {
        path: path.relative(root, file),
        rawBytes: buffer.byteLength,
        gzipBytes: gzipSync(buffer, { level: 9 }).byteLength,
      };
    })
    .sort((left, right) => right.rawBytes - left.rawBytes);

  const js = chunks.reduce(
    (total, chunk) => ({
      files: total.files + 1,
      rawBytes: total.rawBytes + chunk.rawBytes,
      gzipBytes: total.gzipBytes + chunk.gzipBytes,
    }),
    { files: 0, rawBytes: 0, gzipBytes: 0 },
  );

  return {
    packageName: packageJson.name,
    version: packageJson.version,
    generatedAt: new Date().toISOString(),
    js,
    npmPack: collectNpmPack(root),
    ...(options.startupRuns > 0
      ? { startup: collectStartupBenchmarks(root, options.startupRuns) }
      : {}),
    chunks: chunks.slice(0, 20),
  };
}

// The Size workflow measures the base by checking it out, installing, and building; this is
// the same recipe in a detached worktree so the working tree is never touched. Cache semantics
// are per SHA and non-destructive toward anything in use:
//   - .tmp/size-base/<sha12>/ is the worktree; a second run against the same base finds the
//     completeness stamp and skips install+build (mirroring the workflow's dist cache);
//   - .tmp/size-base/<sha12>.lock (pid inside, created O_EXCL) is held from before the worktree
//     is created until the base report has been read, so a concurrent run against the same base
//     fails fast instead of reading a half-built dist, and a run against another base never
//     removes a worktree whose lock is held by a live pid; a lock whose pid is dead is stale;
//   - dist/.size-base-complete is written after a successful build, so an interrupted build is
//     rebuilt rather than trusted because dist/src happens to exist.
function measureBaseRef(root, ref, options) {
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  fs.mkdirSync(path.join(root, '.tmp', 'size-base'), { recursive: true });
  // Canonical: git lists worktrees by real path (/tmp is /private/tmp on macOS), and the
  // registration check below compares against that listing.
  const worktreesRoot = fs.realpathSync(path.join(root, '.tmp', 'size-base'));
  const worktreeDir = path.join(worktreesRoot, sha.slice(0, 12));
  const release = acquireBaseLock(worktreeDir, sha);
  try {
    pruneOtherBaseWorktrees(root, worktreesRoot, worktreeDir);
    ensureBaseWorktree(root, worktreeDir, sha);
    if (!fs.existsSync(baseCompletionStamp(worktreeDir))) {
      process.stderr.write(
        `[size] measuring base ${sha.slice(0, 9)} (${ref}): install + build in ${worktreeDir}\n`,
      );
      execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
        cwd: worktreeDir,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      execFileSync('pnpm', ['build'], { cwd: worktreeDir, stdio: ['ignore', 'ignore', 'inherit'] });
      fs.writeFileSync(baseCompletionStamp(worktreeDir), `${sha}\n`);
    }
    return collectReport(worktreeDir, options);
  } finally {
    release();
  }
}

function baseCompletionStamp(worktreeDir) {
  return path.join(worktreeDir, 'dist', '.size-base-complete');
}

function baseLockPath(worktreeDir) {
  return `${worktreeDir}.lock`;
}

// The lock is a symlink whose *target* is the owner identity (`<pid>:<nonce>`): one syscall
// creates it with its identity in place (no empty-file window for another run to misread as
// stale) and fails EEXIST while held. A stale lock (its pid is dead) is taken over by
// compare-then-unlink on that identity — the unlink is skipped if the link no longer names the
// identity that was judged stale — and every acquisition verifies the link names this run
// before returning. Release unlinks only a link that still names this run.
function acquireBaseLock(worktreeDir, sha) {
  const lockPath = baseLockPath(worktreeDir);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (tryCreateLock(lockPath) && readLockIdentity(lockPath) === LOCK_IDENTITY) {
      return () => releaseLock(lockPath);
    }
    clearStaleLockOrThrow(lockPath, worktreeDir, sha);
  }
  throw new Error(`could not acquire ${lockPath} after repeated stale-lock takeovers`);
}

/** Held by a live process → throw; stale (dead owner) → compare-then-unlink; garbage → remove. */
function clearStaleLockOrThrow(lockPath, worktreeDir, sha) {
  const holder = readLockIdentity(lockPath);
  if (holder === undefined) {
    removeIfNotSymlink(lockPath); // a regular file or directory here is not a lock of this scheme
    return; // or it vanished between our create and read: the caller retries
  }
  if (isProcessAlive(pidOfIdentity(holder))) {
    throw new Error(
      `another \`size --base\` (pid ${pidOfIdentity(holder)}) is using base ${sha.slice(0, 9)} in ${worktreeDir}; wait for it or measure a different base`,
    );
  }
  unlinkIfIdentity(lockPath, holder); // stale: its owner is gone; the caller retries the create
}

function tryCreateLock(lockPath) {
  try {
    fs.symlinkSync(LOCK_IDENTITY, lockPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function releaseLock(lockPath) {
  unlinkIfIdentity(lockPath, LOCK_IDENTITY);
}

/** Compare-then-unlink: never remove a lock that has since come to name someone else. */
function unlinkIfIdentity(lockPath, identity) {
  if (readLockIdentity(lockPath) !== identity) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function removeIfNotSymlink(lockPath) {
  try {
    if (!fs.lstatSync(lockPath).isSymbolicLink())
      fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

function readLockIdentity(lockPath) {
  try {
    return fs.readlinkSync(lockPath);
  } catch {
    return undefined;
  }
}

function pidOfIdentity(identity) {
  const pid = Number(identity.split(':')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function ensureBaseWorktree(root, worktreeDir, sha) {
  const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).includes(`worktree ${worktreeDir}\n`);
  if (registered && fs.existsSync(worktreeDir)) return;
  // Registered but gone (hand-deleted), or present but unregistered (hand-copied): start clean.
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, sha], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
}

// Cache eviction of idle entries only, and only while holding the victim's own lock: a
// worktree whose lock is held by a live pid is in use by another run and is left alone, and a
// run that wants the victim after this check finds it locked (fails fast) rather than finding
// it half-removed.
function pruneOtherBaseWorktrees(root, worktreesRoot, keep) {
  const others = fs
    .readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(worktreesRoot, entry.name))
    .filter((dir) => dir !== keep);
  for (const dir of others) {
    let releaseVictim;
    try {
      releaseVictim = acquireBaseLock(dir, path.basename(dir));
    } catch {
      continue; // in use by a live run: not ours to evict
    }
    try {
      removeWorktree(root, dir);
    } finally {
      releaseVictim();
    }
  }
}

function removeWorktree(root, dir) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'ignore' });
  } catch {
    // Not a registered worktree (a half-created or hand-copied directory): plain removal.
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function prepareGeneratedPackageAssets(root) {
  const packageAppleRunnerScript = path.join(root, 'scripts', 'package-apple-runner-source.mjs');
  if (!fs.existsSync(packageAppleRunnerScript)) {
    return;
  }
  execFileSync(process.execPath, [packageAppleRunnerScript, '--quiet'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function collectStartupBenchmarks(root, runs) {
  return {
    runs,
    benchmarks: STARTUP_BENCHMARKS.map((benchmark) =>
      measureStartupBenchmark(root, benchmark, runs),
    ),
  };
}

function measureStartupBenchmark(root, benchmark, runs) {
  const samplesMs = [];
  runStartupCommand(root, benchmark.args);
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    runStartupCommand(root, benchmark.args);
    samplesMs.push(performance.now() - start);
  }
  const sortedSamples = [...samplesMs].sort((left, right) => left - right);
  return {
    name: benchmark.name,
    command: `agent-device ${benchmark.args.join(' ')}`,
    medianMs: median(sortedSamples),
    minMs: sortedSamples[0],
    maxMs: sortedSamples.at(-1),
    samplesMs,
  };
}

function runStartupCommand(root, args) {
  execFileSync(process.execPath, ['bin/agent-device.mjs', ...args], {
    cwd: root,
    stdio: 'ignore',
    timeout: 5_000,
  });
}

function median(sortedValues) {
  const midpoint = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2
    : sortedValues[midpoint];
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function collectNpmPack(root) {
  const cachePath = path.join(root, '.tmp', 'npm-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  const stdout = execFileSync(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cachePath],
    { cwd: root, encoding: 'utf8' },
  );
  const pack = parseNpmPackOutput(stdout);
  return {
    filename: pack.filename,
    tarballBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    files: countNpmPackEntries(pack),
  };
}

function parseNpmPackOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function countNpmPackEntries(pack) {
  if (typeof pack.entryCount === 'number') return pack.entryCount;
  return Array.isArray(pack.files) ? pack.files.length : 0;
}

function formatMarkdown(report, baseReport, baseLabel) {
  const rows = [
    metricRow('JS raw', baseReport?.js.rawBytes, report.js.rawBytes),
    metricRow('JS gzip', baseReport?.js.gzipBytes, report.js.gzipBytes),
    metricRow('npm tarball', baseReport?.npmPack.tarballBytes, report.npmPack.tarballBytes),
    metricRow('npm unpacked', baseReport?.npmPack.unpackedBytes, report.npmPack.unpackedBytes),
  ];

  const changedChunks = baseReport
    ? formatChangedChunks(report.chunks, baseReport.chunks ?? [])
    : formatTopChunks(report.chunks);
  const startup = formatStartupBenchmarks(report.startup, baseReport?.startup);

  return `${COMMENT_MARKER}
## Size Report

| Metric | ${baseColumnLabel(baseLabel)} | Current | Diff |
|---|---:|---:|---:|
${rows.join('\n')}

${startup}
${changedChunks}
`;
}

function baseColumnLabel(baseLabel) {
  return baseLabel ? `Base (${baseLabel})` : 'Base';
}

function metricRow(label, base, current) {
  return `| ${label} | ${formatMaybeBytes(base)} | ${formatBytes(current)} | ${formatDiff(base, current)} |`;
}

function formatTopChunks(chunks) {
  const rows = chunks.slice(0, 5).map((chunk) => {
    return `| \`${chunk.path}\` | ${formatBytes(chunk.rawBytes)} | ${formatBytes(chunk.gzipBytes)} |`;
  });
  return `Top chunks:

| Chunk | Raw | Gzip |
|---|---:|---:|
${rows.join('\n')}
`;
}

function formatChangedChunks(currentChunks, baseChunks) {
  const baseByPath = new Map(baseChunks.map((chunk) => [chunk.path, chunk]));
  const rows = currentChunks
    .map((chunk) => {
      const base = baseByPath.get(chunk.path);
      return {
        path: chunk.path,
        rawDiff: base ? chunk.rawBytes - base.rawBytes : chunk.rawBytes,
        gzipDiff: base ? chunk.gzipBytes - base.gzipBytes : chunk.gzipBytes,
      };
    })
    .filter((chunk) => chunk.rawDiff !== 0 || chunk.gzipDiff !== 0)
    .sort((left, right) => Math.abs(right.gzipDiff) - Math.abs(left.gzipDiff))
    .slice(0, 5)
    .map((chunk) => {
      return `| \`${chunk.path}\` | ${formatSignedBytes(chunk.rawDiff)} | ${formatSignedBytes(chunk.gzipDiff)} |`;
    });

  if (rows.length === 0) {
    return 'Top changed chunks: no changes in the largest emitted chunks.\n';
  }

  return `Top changed chunks:

| Chunk | Raw diff | Gzip diff |
|---|---:|---:|
${rows.join('\n')}
`;
}

function formatMaybeBytes(value) {
  return typeof value === 'number' ? formatBytes(value) : '-';
}

function formatDiff(base, current) {
  return typeof base === 'number' ? formatSignedBytes(current - base) : '-';
}

function formatStartupBenchmarks(startup, baseStartup) {
  if (!startup) return '';
  const baseByName = new Map(
    (baseStartup?.benchmarks ?? []).map((benchmark) => [benchmark.name, benchmark]),
  );
  const rows = startup.benchmarks.map((benchmark) => {
    const base = baseByName.get(benchmark.name);
    return `| ${benchmark.name} | ${formatMaybeMs(base?.medianMs)} | ${formatMs(benchmark.medianMs)} | ${formatMsDiff(base?.medianMs, benchmark.medianMs)} |`;
  });
  return `Startup median (${startup.runs} runs, lower is better):

| Scenario | Base | Current | Diff |
|---|---:|---:|---:|
${rows.join('\n')}

`;
}

function formatMaybeMs(value) {
  return typeof value === 'number' ? formatMs(value) : '-';
}

function formatMsDiff(base, current) {
  if (typeof base !== 'number') return '-';
  const diff = current - base;
  if (diff === 0) return '0 ms';
  const sign = diff > 0 ? '+' : '-';
  return `${sign}${formatMs(Math.abs(diff))}`;
}

function formatMs(value) {
  return value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function formatBytes(value) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1000) return `${value} B`;
  if (absoluteValue < 1000 * 1000) return `${(value / 1000).toFixed(1)} kB`;
  return `${(value / (1000 * 1000)).toFixed(2)} MB`;
}

function formatSignedBytes(value) {
  if (value === 0) return '0 B';
  const sign = value > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(value))}`;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

// The PR comment is a convenience surface: the same markdown is already in the
// job summary. A GitHub outage (5xx / 429 / network error) must not fail the
// job, but a real misconfiguration (bad token, missing permissions) still does.
async function postGitHubCommentBestEffort(markdownPath, explicitPrNumber) {
  try {
    await postGitHubComment(markdownPath, explicitPrNumber);
  } catch (error) {
    if (!(error instanceof TransientGitHubError)) throw error;
    const message = `Skipping PR size comment after transient GitHub failure: ${error.message}`;
    process.stdout.write(`::warning::${message}\n`);
    appendStepSummary(`> ⚠️ ${message} The size report above is authoritative.\n`);
  }
}

function appendStepSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, text);
}

async function postGitHubComment(markdownPath, explicitPrNumber) {
  const config = readGitHubCommentConfig(explicitPrNumber);
  const body = fs.readFileSync(markdownPath, 'utf8');
  const commentsUrl = buildCommentsUrl(config.repository, config.prNumber);
  await retryTransient(() => syncGitHubComment(commentsUrl, config.headers, body));
}

// Every attempt re-lists before writing: a create whose response was lost
// (network error / 5xx) may still have landed server-side, and re-listing turns
// that into an update of the existing marker comment instead of a duplicate.
async function syncGitHubComment(commentsUrl, headers, body) {
  const comments = await listGitHubComments(commentsUrl, headers);
  const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
  await writeGitHubComment(commentsUrl, headers, body, existing?.url);
}

function readGitHubCommentConfig(explicitPrNumber) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = explicitPrNumber ?? process.env.GITHUB_PR_NUMBER;
  assertGitHubCommentConfig(token, repository, prNumber);
  return {
    repository,
    prNumber,
    headers: buildGitHubHeaders(token),
  };
}

function assertGitHubCommentConfig(token, repository, prNumber) {
  for (const value of [token, repository, prNumber]) {
    if (!value) {
      throw new Error(
        'GITHUB_TOKEN, GITHUB_REPOSITORY, and PR number are required to post a comment.',
      );
    }
  }
}

function buildGitHubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };
}

function buildCommentsUrl(repository, prNumber) {
  const [owner, repo] = repository.split('/');
  return `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
}

async function listGitHubComments(commentsUrl, headers) {
  const response = await githubRequest(
    `${commentsUrl}?per_page=100`,
    { headers },
    'list PR comments',
  );
  return await response.json();
}

async function writeGitHubComment(commentsUrl, headers, body, existingUrl) {
  const target = commentWriteTarget(commentsUrl, existingUrl);
  await githubRequest(
    target.url,
    { method: target.method, headers, body: JSON.stringify({ body }) },
    `${target.action} PR comment`,
  );
}

function commentWriteTarget(commentsUrl, existingUrl) {
  if (existingUrl) {
    return { url: existingUrl, method: 'PATCH', action: 'update' };
  }
  return { url: commentsUrl, method: 'POST', action: 'create' };
}

// Re-runs `operation` with exponential backoff while it throws
// TransientGitHubError; any other error (a non-transient HTTP status, i.e. a
// configuration problem) propagates immediately and fails the job.
async function retryTransient(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      await backoffOrRethrow(error, attempt);
    }
  }
}

async function backoffOrRethrow(error, attempt) {
  if (!(error instanceof TransientGitHubError)) throw error;
  if (attempt >= GITHUB_REQUEST_ATTEMPTS) {
    throw new TransientGitHubError(`${error.message} after ${attempt} attempts`);
  }
  const delayMs = GITHUB_RETRY_BASE_MS * 2 ** (attempt - 1);
  process.stderr.write(`${error.message} (retrying in ${delayMs}ms)\n`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

// One attempt: network errors and 5xx / 429 throw TransientGitHubError;
// any other non-OK status throws a plain (fatal) Error.
async function githubRequest(url, init, action) {
  const response = await fetchOrTransient(url, init, action);
  if (response.ok) return response;
  throw await githubStatusError(response, action);
}

async function fetchOrTransient(url, init, action) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new TransientGitHubError(`Failed to ${action}: ${error?.message ?? error}`);
  }
}

async function githubStatusError(response, action) {
  const failure = `Failed to ${action}: ${response.status} ${await response.text()}`;
  return isTransientGitHubStatus(response.status)
    ? new TransientGitHubError(failure)
    : new Error(failure);
}

function isTransientGitHubStatus(status) {
  return status === 429 || status >= 500;
}
