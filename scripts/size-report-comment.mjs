// Publishing the size report as a PR comment — the convenience half of `scripts/size-report.mjs`,
// kept separate from measuring and formatting it. The same markdown always reaches the job
// summary, so this surface is best-effort by design: a GitHub outage must not fail the job, while
// a real misconfiguration still must.
//
// `scripts/__tests__/size-report-post-comment.test.ts` drives this through the real script with a
// stubbed fetch, pinning the retry, reconcile, and fatal outcomes.

import fs from 'node:fs';

/** Identifies this job's comment so re-runs update one comment instead of appending new ones. */
export const COMMENT_MARKER = '<!-- agent-device-size-report -->';

const GITHUB_REQUEST_ATTEMPTS = 4;
// Overridable so the regression tests do not sleep through real backoff.
const GITHUB_RETRY_BASE_MS = Number(process.env.SIZE_REPORT_RETRY_BASE_MS ?? 1000);

class TransientGitHubError extends Error {}

// The PR comment is a convenience surface: the same markdown is already in the
// job summary. A GitHub outage (5xx / 429 / network error) must not fail the
// job, but a real misconfiguration (bad token, missing permissions) still does.
export async function postGitHubCommentBestEffort(markdownPath, explicitPrNumber) {
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
