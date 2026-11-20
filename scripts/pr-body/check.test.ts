// Tests for the pull-request body gate's entry point (scripts/pr-body/check.ts).
//
// The rules are pinned in model.test.ts. What is pinned here is the plumbing those tests cannot
// reach: the body is read from the event payload rather than the tree, the SHA verdict comes from
// the checkout, and a payload or head the runner did not provide is a refusal rather than a verdict.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { run } from './check.ts';
import { beginStderrCapture, beginStdoutCapture } from '@agent-device/test-kit';

let repo: string;
let eventPath: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** One commit, so a body can name a SHA the checkout really has. */
function commit(message: string): string {
  fs.writeFileSync(path.join(repo, 'f.txt'), message);
  git('add', 'f.txt');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

function writeEvent(pr: Record<string, unknown>): void {
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: pr }));
}

function bodyAt(sha: string): string {
  return `## Summary\n\nWaits for the process. Closes #4700.\n\n## Before / after\n\n\`close --shutdown\` returns later now.\n\n## Validation\n\nTested at \`${sha}\`. \`pnpm check:affected --run\` passed.`;
}

/** Runs the gate with the reporters silenced, keeping everything it printed. */
function check(argv: string[]): { code: number; out: string } {
  const stdout = beginStdoutCapture();
  const stderr = beginStderrCapture();
  try {
    const code = run(argv, repo);
    return { code, out: stdout.read() + stderr.read() };
  } finally {
    stdout.restore();
    stderr.restore();
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-'));
  eventPath = path.join(repo, 'event.json');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a body naming a commit the checkout carries passes', () => {
  const head = commit('head');
  writeEvent({
    title: 'fix(close): wait for the process',
    body: bodyAt(head.slice(0, 10)),
    draft: false,
    head: { sha: head },
    user: { login: 'thymikee', type: 'User' },
  });
  const { code, out } = check(['--event', eventPath]);
  assert.equal(code, 0, out);
  assert.match(out, /pr body: ok/);
});

test('a body naming a commit the repository does not have fails', () => {
  const head = commit('head');
  const invented = 'b'.repeat(40);
  writeEvent({
    title: 'fix(close): wait for the process',
    body: bodyAt(invented),
    draft: false,
    head: { sha: head },
    user: { login: 'thymikee', type: 'User' },
  });
  const { code, out } = check(['--event', eventPath]);
  assert.equal(code, 1, out);
  assert.match(out, /not a commit this repository has/);
});

test('a head the checkout does not carry is reported as unverified, not as stale', () => {
  commit('head');
  writeEvent({
    title: 'fix(close): wait for the process',
    body: bodyAt('c'.repeat(40)),
    draft: false,
    head: { sha: 'd'.repeat(40) },
    user: { login: 'thymikee', type: 'User' },
  });
  const { code, out } = check(['--event', eventPath]);
  assert.equal(code, 0, out);
  assert.match(out, /does not carry the PR head/);
});

test('a draft passes without reading its body', () => {
  commit('head');
  writeEvent({
    title: 'feat(audit): add a check',
    body: '',
    draft: true,
    head: { sha: 'e'.repeat(40) },
    user: { login: 'thymikee', type: 'User' },
  });
  const { code, out } = check(['--event', eventPath]);
  assert.equal(code, 0, out);
  assert.match(out, /skipped — the pull request is a draft/);
});

test('a missing payload is a refusal rather than a verdict', () => {
  const missing = path.join(repo, 'absent.json');
  const { code, out } = check(['--event', missing]);
  assert.equal(code, 1, out);
  assert.match(out, /no verdict — no event payload/);
});

test('a payload without a pull request or a head is a refusal', () => {
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { name: 'agent-device' } }));
  const notPr = check(['--event', eventPath]);
  assert.equal(notPr.code, 1, notPr.out);
  assert.match(notPr.out, /carries no pull_request object/);

  fs.writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { title: 'fix(x): y', body: '', draft: false } }),
  );
  const noHead = check(['--event', eventPath]);
  assert.equal(noHead.code, 1, noHead.out);
  assert.match(noHead.out, /names no pull_request\.head\.sha/);
});

test('the head may be named on the command line instead of the payload', () => {
  const head = commit('head');
  writeEvent({
    title: 'fix(close): wait for the process',
    body: bodyAt(head.slice(0, 10)),
    draft: false,
    user: { login: 'thymikee', type: 'User' },
  });
  const { code, out } = check(['--event', eventPath, '--head', head]);
  assert.equal(code, 0, out);
});

test('failures are written to the job summary when one is configured', () => {
  const head = commit('head');
  const summary = path.join(repo, 'summary.md');
  writeEvent({
    title: 'feat(audit): add a check',
    body: '## Summary\n\nAdds it.',
    draft: false,
    head: { sha: head },
    user: { login: 'thymikee', type: 'User' },
  });
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    const { code, out } = check(['--event', eventPath]);
    assert.equal(code, 1, out);
    const written = fs.readFileSync(summary, 'utf8');
    assert.match(written, /## Pull request body/);
    assert.match(written, /Before \/ after rule/);
  } finally {
    delete process.env.GITHUB_STEP_SUMMARY;
  }
});
