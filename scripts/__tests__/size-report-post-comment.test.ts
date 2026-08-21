import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import {
  classifyNpmPackEntry,
  formatMarkdown,
  summarizeNpmPackComponents,
} from '../size-report.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'size-report.mjs');
const MARKER = '<!-- agent-device-size-report -->';
const SIZE_FIXTURE = join(
  import.meta.dirname,
  'fixtures',
  'size-report-npm-pack.json',
);

// Each entry answers one fetch call, in order. `net` rejects the fetch (a
// dropped connection); a number is the HTTP status; `body` is the response
// text (defaults to `[]` for 200 so a list call sees no comments).
type StubResponse = { status: number | 'net'; body?: string };

const FETCH_STUB = `
import fs from 'node:fs';
const script = JSON.parse(process.env.SIZE_REPORT_FETCH_SCRIPT);
let index = 0;
globalThis.fetch = async (url, init) => {
  const step = script[Math.min(index, script.length - 1)];
  index += 1;
  fs.appendFileSync(process.env.SIZE_REPORT_FETCH_LOG, \`\${init?.method ?? 'GET'} \${url}\\n\`);
  if (step.status === 'net') throw new Error('ECONNRESET');
  const body = step.body ?? (step.status === 200 ? '[]' : \`{"message":"status \${step.status}"}\`);
  return new Response(body, { status: step.status });
};
`;

async function runPostComment(script: StubResponse[]) {
  const dir = await mkdtemp(join(tmpdir(), 'size-report-post-comment-'));
  const stubPath = join(dir, 'fetch-stub.mjs');
  const reportPath = join(dir, 'report.md');
  const logPath = join(dir, 'fetch.log');
  const summaryPath = join(dir, 'summary.md');
  await Promise.all([
    writeFile(stubPath, FETCH_STUB),
    writeFile(reportPath, `${MARKER}\n# report\n`),
    writeFile(logPath, ''),
    writeFile(summaryPath, ''),
  ]);
  const env = {
    ...process.env,
    GITHUB_TOKEN: 'token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_PR_NUMBER: '1',
    GITHUB_STEP_SUMMARY: summaryPath,
    SIZE_REPORT_RETRY_BASE_MS: '1',
    SIZE_REPORT_FETCH_SCRIPT: JSON.stringify(script),
    SIZE_REPORT_FETCH_LOG: logPath,
  };
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', stubPath, SCRIPT, '--post-comment', reportPath],
      { env },
    ));
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = failure.code ?? 1;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
  }
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
  const summary = await readFile(summaryPath, 'utf8');
  return { exitCode, stdout, stderr, calls, summary };
}

const COMMENTS_URL = 'https://api.github.com/repos/owner/repo/issues/1/comments';
const EXISTING_COMMENT_URL = `${COMMENTS_URL}/42`;
const existingMarkerComment = JSON.stringify([
  { url: EXISTING_COMMENT_URL, body: `${MARKER}\nold` },
]);

test('a create whose response was lost is reconciled into an update, not a duplicate', async () => {
  const result = await runPostComment([
    { status: 200 }, // list: nothing yet
    { status: 'net' }, // create: connection dropped, but it landed server-side
    { status: 200, body: existingMarkerComment }, // re-list: marker comment now exists
    { status: 200 }, // update
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.calls, [
    `GET ${COMMENTS_URL}?per_page=100`,
    `POST ${COMMENTS_URL}`,
    `GET ${COMMENTS_URL}?per_page=100`,
    `PATCH ${EXISTING_COMMENT_URL}`,
  ]);
});

test('transient failures that outlast the retries warn and exit 0', async () => {
  const result = await runPostComment([{ status: 503 }]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    result.stdout,
    /^::warning::Skipping PR size comment after transient GitHub failure: .*503/m,
  );
  assert.match(result.summary, /Skipping PR size comment/);
  assert.equal(result.calls.length, 4, 'one list call per attempt');
});

test('a non-transient 4xx is fatal and is not retried', async () => {
  const result = await runPostComment([{ status: 200 }, { status: 401 }]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Failed to create PR comment: 401/);
  assert.doesNotMatch(result.stdout, /::warning::/);
  assert.equal(result.calls.length, 2, 'no retry after a fatal status');
});

const fixturePack = JSON.parse(await readFile(SIZE_FIXTURE, 'utf8'));

test('classifies every shipped entry into one named component', () => {
  const classified = fixturePack.files.map(classifyNpmPackEntry);

  assert.deepEqual(
    classified.map((entry) => [entry.path, entry.component]),
    [
      ['dist/src/index.js', 'js'],
      ['dist/src/index.d.ts', 'js'],
      ['dist/apple/runner/RunnerTests.swift', 'apple-runner'],
      ['apple/macos-helper/Sources/main.swift', 'macos-helper'],
      ['android/snapshot-helper/dist/helper.apk', 'android-helpers'],
      ['package.json', 'other'],
      ['vendor/unknown.bin', 'other'],
    ],
  );
});

test('unknown package paths fall into other', () => {
  assert.equal(
    classifyNpmPackEntry({ path: 'new/future-package-file', size: 13 }).component,
    'other',
  );
});

test('component bytes sum exactly to npm pack unpackedSize', () => {
  const components = summarizeNpmPackComponents(fixturePack);

  assert.equal(
    components.reduce((total, component) => total + component.unpackedBytes, 0),
    fixturePack.unpackedSize,
  );
  assert.deepEqual(
    Object.fromEntries(
      components.map((component) => [component.id, component.unpackedBytes]),
    ),
    {
      js: 503,
      'apple-runner': 503,
      'macos-helper': 211,
      'android-helpers': 307,
      other: 177,
    },
  );
  assert.throws(
    () => summarizeNpmPackComponents({ ...fixturePack, unpackedSize: 1700 }),
    /does not match npm pack unpackedSize/,
  );
});

test('Markdown reports component diffs and changed packed files', () => {
  const current = {
    js: { rawBytes: 10, gzipBytes: 8 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 1701,
      components: summarizeNpmPackComponents(fixturePack),
      entries: fixturePack.files,
    },
    chunks: [],
  };
  const baseEntries = fixturePack.files.map((entry) =>
    entry.path === 'dist/src/index.js' ? { ...entry, size: 300 } : entry,
  );
  const base = {
    js: { rawBytes: 10, gzipBytes: 8 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 1600,
      components: summarizeNpmPackComponents({
        ...fixturePack,
        unpackedSize: 1600,
        files: baseEntries,
      }),
      entries: baseEntries,
    },
    chunks: [],
  };

  const markdown = formatMarkdown(current, base);

  assert.match(markdown, /### npm unpacked components/);
  assert.match(markdown, /\| JS \/ dist source \| 402 B \| 503 B \| \+101 B \|/);
  assert.match(markdown, /\| Other package files \| 177 B \| 177 B \| 0 B \|/);
  assert.match(markdown, /### Top changed packed files/);
  assert.match(markdown, /`dist\/src\/index\.js` \| 300 B \| 401 B \| \+101 B/);
});
