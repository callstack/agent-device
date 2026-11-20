// Entry point for the pull-request body gate:
// `pnpm check:pr-body [--event <path>] [--head <sha>]`.
//
// Reads the pull request from the GitHub event payload that the runner writes to
// `GITHUB_EVENT_PATH`, never from the checked-out tree, so the gate can run on a fork pull request
// without executing anything the fork contributed. The rules themselves live in `model.ts`; this
// file only answers the one question the model cannot: whether a SHA the body names is still an
// ancestor of the PR head.
//
// A body that names a SHA no longer in the PR is stale, which is the failure this gate exists to
// catch: a pushed commit that rewrote history leaves a body describing commits that left the PR.
// When this checkout cannot resolve the head or the named SHA, the gate says so instead of guessing.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runEntrypoint } from '../lib/cli-entrypoint.ts';
import {
  checkPullRequest,
  type BodyVerdict,
  type PullRequestFacts,
  type ShaResolution,
} from './model.ts';

const USAGE =
  'Usage: pnpm check:pr-body [--event <path>] [--head <sha>]\n' +
  '\n' +
  '  --event  pull_request event payload JSON. Defaults to $GITHUB_EVENT_PATH.\n' +
  '  --head   PR head SHA to compare the Validation SHA with. Defaults to the payload head.\n';

type EventPayload = {
  pull_request?: {
    title?: string;
    body?: string | null;
    draft?: boolean;
    head?: { sha?: string };
    user?: { login?: string; type?: string };
  };
};

/** Why the payload cannot be read, in the shape the caller prints as a refusal. */
type Payload =
  | { readonly ok: true; readonly facts: Omit<PullRequestFacts, 'resolveValidationSha'> }
  | { readonly ok: false; readonly reason: string };

function readPayload(eventPath: string | undefined, headArg: string | undefined): Payload {
  if (!eventPath) {
    return {
      ok: false,
      reason:
        'no event payload path: set GITHUB_EVENT_PATH (the runner sets it) or pass --event <path>.',
    };
  }
  if (!fs.existsSync(eventPath)) {
    return { ok: false, reason: `no event payload at ${eventPath}.` };
  }
  let payload: EventPayload;
  try {
    payload = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as EventPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${eventPath} is not readable JSON: ${message}` };
  }
  const pr = payload.pull_request;
  if (!pr) {
    return {
      ok: false,
      reason: `${eventPath} carries no pull_request object, so this is not a pull_request event.`,
    };
  }
  const head = headArg ?? pr.head?.sha;
  if (!head) {
    return {
      ok: false,
      reason:
        `${eventPath} names no pull_request.head.sha and no --head was passed, ` +
        'so the tested SHA cannot be compared with the head.',
    };
  }
  return {
    ok: true,
    facts: {
      title: pr.title ?? '',
      body: pr.body ?? '',
      author: pr.user?.login ?? '',
      authorType: pr.user?.type ?? '',
      draft: pr.draft === true,
      head,
    },
  };
}

/**
 * Answers whether one commit is still in the PR head's history.
 *
 * Two cases make the verdict impossible rather than negative. In a shallow clone, a commit the graft
 * never fetched is indistinguishable from one a rebase rewrote away. And a checkout that does not
 * carry the head cannot walk to it at all. Both yield `unknown`, which the caller prints as a note:
 * provenance the environment cannot see is not evidence about the body.
 */
function createShaResolver(repoRoot: string, head: string): (sha: string) => ShaResolution {
  const git = (args: readonly string[]): number =>
    runCmdSync('git', [...args], { cwd: repoRoot, allowFailure: true }).exitCode;
  const stdout = (args: readonly string[]): string =>
    runCmdSync('git', [...args], { cwd: repoRoot, allowFailure: true }).stdout.trim();
  if (git(['rev-parse', '--git-dir']) !== 0)
    return () => ({ verdict: 'unknown', reason: `${repoRoot} is not a git repository` });
  if (stdout(['rev-parse', '--is-shallow-repository']) === 'true')
    return () => ({
      verdict: 'unknown',
      reason: 'this is a shallow clone, which cannot tell a rewritten commit from an unfetched one',
    });
  if (git(['cat-file', '-e', `${head}^{commit}`]) !== 0)
    return () => ({
      verdict: 'unknown',
      reason: `this checkout does not carry the PR head ${head.slice(0, 10)}`,
    });
  return (sha) => {
    if (git(['cat-file', '-e', `${sha}^{commit}`]) !== 0) return { verdict: 'unreachable' };
    return git(['merge-base', '--is-ancestor', sha, head]) === 0
      ? { verdict: 'ancestor' }
      : { verdict: 'diverged' };
  };
}

function report(verdict: BodyVerdict, title: string): number {
  if (verdict.exemption) {
    process.stdout.write(`pr body: skipped — ${verdict.exemption} ("${title}").\n`);
    return 0;
  }
  for (const note of verdict.notes) process.stdout.write(`pr body: note — ${note}\n`);
  if (verdict.violations.length === 0) {
    process.stdout.write(`pr body: ok — "${title}" at ${verdict.words} words.\n`);
    return 0;
  }
  for (const violation of verdict.violations)
    process.stderr.write(`pr body: ${violation.message}\n`);
  process.stderr.write(
    `pr body: ${verdict.violations.length} failure(s). The rules live in scripts/pr-body/model.ts; ` +
      '.github/pull_request_template.md lists the sections.\n',
  );
  return 1;
}

/**
 * Writes the failures to the job summary when this runs in CI, so the author reads them on the check's
 * summary page rather than only in its log.
 */
function summarize(verdict: BodyVerdict): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file || verdict.violations.length === 0) return;
  const lines = [
    '## Pull request body',
    '',
    ...verdict.violations.map((violation) => `- ${violation.message}`),
    '',
    'The rules live in `scripts/pr-body/model.ts`; `.github/pull_request_template.md` lists the sections.',
    '',
  ];
  fs.appendFileSync(file, lines.join('\n'));
}

export function run(argv: readonly string[], cwd?: string): number {
  const values = parseScriptArgs(argv, USAGE, {
    event: { type: 'string' },
    head: { type: 'string' },
  });
  const payload = readPayload(values.event ?? process.env.GITHUB_EVENT_PATH, values.head);
  if (!payload.ok) {
    process.stderr.write(`check:pr-body: no verdict — ${payload.reason}\n`);
    return 1;
  }
  const facts = payload.facts;
  const root =
    cwd ??
    runCmdSync('git', ['rev-parse', '--show-toplevel'], { allowFailure: true }).stdout.trim();
  const repoRoot = path.isAbsolute(root) && root ? root : process.cwd();
  const verdict = checkPullRequest({
    ...facts,
    resolveValidationSha: createShaResolver(repoRoot, facts.head),
  });
  summarize(verdict);
  return report(verdict, facts.title);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runEntrypoint('check:pr-body', async () => run(process.argv.slice(2)));
}
