#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

const COMMENT_MARKER = '<!-- agent-device-size-report -->';
const VALUE_ARGS = new Map([
  ['--cwd', 'cwd'],
  ['--json', 'json'],
  ['--markdown', 'markdown'],
  ['--compare', 'compare'],
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
  await postGitHubComment(args.postComment, args.pr);
  process.exit(0);
}

const report = collectReport(cwd, {
  startupRuns: parseNonNegativeInteger(args.startupRuns ?? '0', '--startup-runs'),
});
const baseReport = args.compare ? JSON.parse(fs.readFileSync(args.compare, 'utf8')) : null;

if (args.json) {
  writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
}

const markdown = formatMarkdown(report, baseReport);

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

function formatMarkdown(report, baseReport) {
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

| Metric | Base | Current | Diff |
|---|---:|---:|---:|
${rows.join('\n')}

${startup}
${changedChunks}
`;
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
  return `${(value / (1000 * 1000)).toFixed(1)} MB`;
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

async function postGitHubComment(markdownPath, explicitPrNumber) {
  const config = readGitHubCommentConfig(explicitPrNumber);
  const body = fs.readFileSync(markdownPath, 'utf8');
  const commentsUrl = buildCommentsUrl(config.repository, config.prNumber);
  const comments = await listGitHubComments(commentsUrl, config.headers);
  const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
  await writeGitHubComment(commentsUrl, config.headers, body, existing?.url);
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
  const response = await fetch(`${commentsUrl}?per_page=100`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to list PR comments: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function writeGitHubComment(commentsUrl, headers, body, existingUrl) {
  const target = commentWriteTarget(commentsUrl, existingUrl);
  const response = await fetch(target.url, {
    method: target.method,
    headers,
    body: JSON.stringify({ body }),
  });
  await assertGitHubWriteResponse(response, target.action);
}

function commentWriteTarget(commentsUrl, existingUrl) {
  if (existingUrl) {
    return { url: existingUrl, method: 'PATCH', action: 'update' };
  }
  return { url: commentsUrl, method: 'POST', action: 'create' };
}

async function assertGitHubWriteResponse(response, action) {
  if (!response.ok) {
    throw new Error(`Failed to ${action} PR comment: ${response.status} ${await response.text()}`);
  }
}
