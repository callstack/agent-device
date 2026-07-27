// GitHub API access for the scheduled-lane health job (#1430).
//
// Only the two calls the job needs: recent `schedule`-triggered runs of a workflow, and upsert of
// the single alert issue. Kept behind one module so the health logic stays pure and testable.

import type { LaneHistory, LaneRun } from './health-model.ts';

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

type RunsResponse = {
  workflow_runs?: { conclusion: string | null; created_at: string; html_url: string }[];
};

type WorkflowResponse = { created_at?: string };

type IssuesResponse = { number: number; title: string }[];

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
}

/** Plain field, not a constructor parameter property: Node's type stripping rejects those. */
class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: headers(token) });
  if (!response.ok) {
    const method = init?.method ?? 'GET';
    throw new HttpError(response.status, `${method} ${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** `null` for 404 only; every other status stays an error. */
async function requestOrNullOn404<T>(token: string, url: string): Promise<T | null> {
  try {
    return await request<T>(token, url);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

function toLaneRun(run: { conclusion: string | null; created_at: string; html_url: string }) {
  return {
    conclusion: (run.conclusion ?? null) as LaneRun['conclusion'],
    createdAt: run.created_at,
    url: run.html_url,
  };
}

/** When the lane was added: it decides whether an empty history is a newborn lane or a dead one. */
async function fetchRegisteredAt(
  token: string,
  repo: string,
  workflow: string,
): Promise<string | null> {
  const body = await requestOrNullOn404<WorkflowResponse>(
    token,
    `${API}/repos/${repo}/actions/workflows/${workflow}`,
  );
  return body?.created_at ?? null;
}

/**
 * Newest-first scheduled runs. A 404 means the workflow is not on the default branch yet (a lane
 * being born, as in this PR), which is unknown history rather than a dark lane.
 */
export async function fetchScheduledRuns(input: {
  token: string;
  repo: string;
  workflow: string;
  perPage: number;
}): Promise<LaneHistory> {
  const url = `${API}/repos/${input.repo}/actions/workflows/${input.workflow}/runs?event=schedule&per_page=${input.perPage}`;
  const body = await requestOrNullOn404<RunsResponse>(input.token, url);
  if (body === null) {
    return { known: false, reason: 'workflow not on the default branch yet', runs: [] };
  }
  return {
    known: true,
    registeredAt: await fetchRegisteredAt(input.token, input.repo, input.workflow),
    runs: (body.workflow_runs ?? []).map(toLaneRun),
  };
}

/** Creates the alert issue, or comments on it when it is already open. */
export async function upsertAlertIssue(input: {
  token: string;
  repo: string;
  title: string;
  body: string;
}): Promise<{ action: 'created' | 'commented'; number: number }> {
  const open = await request<IssuesResponse>(
    input.token,
    `${API}/repos/${input.repo}/issues?state=open&per_page=100`,
  );
  const existing = open.find((issue) => issue.title === input.title);
  if (!existing) {
    const created = await request<{ number: number }>(
      input.token,
      `${API}/repos/${input.repo}/issues`,
      { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body }) },
    );
    return { action: 'created', number: created.number };
  }
  await request(input.token, `${API}/repos/${input.repo}/issues/${existing.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: input.body }),
  });
  return { action: 'commented', number: existing.number };
}
