import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  compareReleaseVersions,
  isReleaseVersion,
  latestNightlyTag,
  nightlyBase,
  nightlyVersion,
  previousReleaseTag,
} from './release-version.mjs';

/**
 * Decides what one `.github/workflows/release.yml` run does, from the event that started it:
 *   pull_request              dry-run: build and verify every package, publish nothing
 *   schedule / dispatch       nightly: publish main's HEAD under the `nightly` dist-tag
 *   vX.Y.Z tag                stable: publish that commit under the `latest` dist-tag
 * `tags` maps remote tag names to commits; `ciConclusion` and `onMain` describe `sha`.
 */
export function planRelease(run) {
  if (run.event === 'pull_request') {
    return { mode: 'dry-run', version: nightlyVersion(run.rootVersion, run.today, run.runNumber) };
  }
  if (run.ref.startsWith('refs/tags/')) return planStable(run, run.ref.slice('refs/tags/'.length));
  if (run.ref !== 'refs/heads/main') {
    throw new Error(`Releases run from main or a vX.Y.Z tag, not ${run.ref}.`);
  }
  return planNightly(run);
}

function planNightly(run) {
  const scheduled = run.event === 'schedule';
  const latest = latestNightlyTag([...run.tags.keys()]);
  if (scheduled && latest && run.tags.get(latest) === run.sha) {
    return skip(`${latest} already ships ${run.sha}.`);
  }
  // The npm dist-tag is the durable record: a nightly can publish and then fail to tag.
  const shippedToday = [latest, run.publishedNightly].find((shipped) =>
    shipped?.includes(`-nightly.${run.today}.`),
  );
  if (scheduled && shippedToday) return skip(`${shippedToday} shipped today.`);
  if (run.ciConclusion !== 'success') {
    const reason = `CI on ${run.sha} is ${run.ciConclusion}; a nightly ships only a commit whose CI passed.`;
    if (scheduled) return skip(reason);
    throw new Error(reason);
  }
  const version = nightlyVersion(run.rootVersion, run.today, run.runNumber);
  assertAheadOfStable(run, nightlyBase(version));
  return { mode: 'nightly', version, distTag: 'nightly', commit: run.sha };
}

function planStable(run, tag) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !isReleaseVersion(version)) {
    throw new Error(`Stable releases run from a vX.Y.Z tag, not ${tag}.`);
  }
  // An equal version is a retry: the publisher skips packages already on the registry.
  if (run.latestStable && compareReleaseVersions(version, run.latestStable) < 0) {
    throw new Error(`${version} is older than the published ${run.latestStable}.`);
  }
  if (!run.onMain) throw new Error(`${tag} is not on main.`);
  if (run.ciConclusion !== 'success') {
    throw new Error(
      `CI on ${run.sha} is ${run.ciConclusion}. Once it passes, run Release on ${tag} to publish it.`,
    );
  }
  const previousTag = previousReleaseTag([...run.tags.keys()], version) ?? '';
  return { mode: 'stable', version, distTag: 'latest', commit: run.sha, previousTag };
}

const VERSION_FILE = /^(packages\/[^/]+\/)?package\.json$|^server\.json$/;

/**
 * Whether a single-parent commit only rewrites `"version"` fields, as the release workflow's
 * `-dev` bump does. Its push runs no workflows, so the parent's CI stands for it.
 */
export function isVersionOnlyCommit(commit) {
  return (
    commit.parents.length === 1 &&
    commit.files.length > 0 &&
    commit.files.every(
      (file) =>
        VERSION_FILE.test(file.filename) &&
        typeof file.patch === 'string' &&
        file.patch
          .split('\n')
          .filter((line) => /^[+-]/.test(line))
          .every((line) => /^[+-]\s*"version": "[^"]*",?$/.test(line)),
    )
  );
}

function skip(reason) {
  return { mode: 'skip', reason };
}

/**
 * What GitHub must enforce before any publish, since npm trusts every run of release.yml that
 * reaches the npm-publish environment and a run's own copy of this script proves nothing.
 */
export function repositorySetupGaps({ npmPublish, npmPublishPolicies, release, tagRulesets }) {
  const gaps = [];
  const allowed = new Set(npmPublishPolicies.map((policy) => `${policy.type}:${policy.name}`));
  const onlyMainAndTags = allowed.size === 2 && allowed.has('branch:main') && allowed.has('tag:v*');
  if (!npmPublish?.deployment_branch_policy?.custom_branch_policies || !onlyMainAndTags) {
    gaps.push('the npm-publish environment must deploy only from branch main and tags v*');
  }
  const reviewers = release?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (!reviewers?.reviewers?.length) gaps.push('the release environment must require a reviewer');
  if (!tagRulesets.some(guardsReleaseTags)) {
    gaps.push(
      'an active tag ruleset must restrict creating, updating, and deleting every refs/tags/v* tag, ' +
        'with no exclusions and only admins able to bypass',
    );
  }
  return gaps;
}

/**
 * A ruleset covers every `v*` tag only with no exclusions. GitHub returns `bypass_actors` only to
 * admins, never to the Plan job's token, so the admin-only bypass is checked where it is visible.
 */
function guardsReleaseTags(ruleset) {
  const types = new Set(ruleset.rules.map((rule) => rule.type));
  const refs = ruleset.conditions?.ref_name;
  return (
    ruleset.enforcement === 'active' &&
    (refs?.include?.includes('refs/tags/v*') || refs?.include?.includes('~ALL')) &&
    (refs.exclude ?? []).length === 0 &&
    ['creation', 'update', 'deletion'].every((type) => types.has(type)) &&
    (ruleset.bypass_actors ?? []).every(isAdminBypass)
  );
}

function isAdminBypass(actor) {
  return (
    actor.actor_type === 'OrganizationAdmin' ||
    (actor.actor_type === 'RepositoryRole' && actor.actor_id === REPOSITORY_ADMIN_ROLE)
  );
}

const REPOSITORY_ADMIN_ROLE = 5;

function assertAheadOfStable(run, version) {
  if (run.latestStable && compareReleaseVersions(version, run.latestStable) <= 0) {
    throw new Error(
      `${version} is not ahead of the published ${run.latestStable}. Move main's -dev version past it.`,
    );
  }
}

/** Remote release and nightly tags by name, resolved to the commit each one points at. */
function remoteTags() {
  const tags = new Map();
  const output = execFileSync('git', ['ls-remote', '--tags', 'origin', 'v*', 'nightly/*'], {
    encoding: 'utf8',
  });
  for (const line of output.split('\n').filter(Boolean)) {
    const [commit, name] = line.split('\t');
    const tag = name.replace(/^refs\/tags\//, '');
    if (tag.endsWith('^{}')) tags.set(tag.slice(0, -3), commit);
    else if (!tags.has(tag)) tags.set(tag, commit);
  }
  return tags;
}

async function ciConclusion(env, sha) {
  const { workflow_runs: runs } = await github(
    env,
    `actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`,
  );
  if (runs.length > 0) return runs[0].status === 'completed' ? runs[0].conclusion : runs[0].status;
  const commit = await github(env, `commits/${sha}`);
  return isVersionOnlyCommit(commit) ? ciConclusion(env, commit.parents[0].sha) : 'missing';
}

// `missing` included: a tag pushed right after a merge can arrive before the merge's CI run exists.
const UNSETTLED_CI = new Set([
  'missing',
  'requested',
  'queued',
  'waiting',
  'pending',
  'in_progress',
]);

/** A tag pushed right after a merge waits, within the Plan job's budget, for that merge's CI. */
async function settledCiConclusion(env, sha) {
  for (let attempt = 0; ; attempt += 1) {
    const conclusion = await ciConclusion(env, sha);
    if (!UNSETTLED_CI.has(conclusion) || attempt >= 40) {
      return conclusion;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

async function isOnMain(env) {
  const { status } = await github(env, `compare/main...${env.GITHUB_SHA}`);
  return status === 'identical' || status === 'behind';
}

async function publishedVersion(distTag) {
  const response = await fetch(`https://registry.npmjs.org/agent-device/${distTag}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry lookup failed: ${response.status}`);
  return (await response.json()).version;
}

async function github(env, pathname) {
  const response = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
    },
  });
  if (!response.ok) {
    throw Object.assign(new Error(`GitHub API ${pathname} failed: ${response.status}`), {
      status: response.status,
    });
  }
  return response.json();
}

/** A missing environment is a setup gap; any other failure must not read as one. */
function absentOn404(fallback) {
  return (error) => {
    if (error.status === 404) return fallback;
    throw error;
  };
}

async function readRepositorySetup(env) {
  const environment = (name) => github(env, `environments/${name}`).catch(absentOn404(null));
  const summaries = await github(env, 'rulesets?targets=tag');
  return {
    npmPublish: await environment('npm-publish'),
    npmPublishPolicies: await github(env, 'environments/npm-publish/deployment-branch-policies')
      .then((body) => body.branch_policies)
      .catch(absentOn404([])),
    release: await environment('release'),
    tagRulesets: await Promise.all(
      summaries.map((summary) => github(env, `rulesets/${summary.id}`)),
    ),
  };
}

async function readRun(env) {
  const event = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF;
  const onBranch = event !== 'pull_request' && ref === 'refs/heads/main';
  const onTag = ref.startsWith('refs/tags/');
  return {
    event,
    ref,
    sha: env.GITHUB_SHA,
    rootVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    today: new Date().toISOString().slice(0, 10).replaceAll('-', ''),
    runNumber: env.GITHUB_RUN_NUMBER,
    tags: event === 'pull_request' ? new Map() : remoteTags(),
    latestStable: onBranch || onTag ? await publishedVersion('latest') : null,
    publishedNightly: onBranch ? await publishedVersion('nightly') : null,
    ciConclusion: onTag
      ? await settledCiConclusion(env, env.GITHUB_SHA)
      : onBranch
        ? await ciConclusion(env, env.GITHUB_SHA)
        : undefined,
    onMain: onTag ? await isOnMain(env) : undefined,
  };
}

const OUTPUTS = {
  mode: 'mode',
  version: 'version',
  dist_tag: 'distTag',
  commit: 'commit',
  previous_tag: 'previousTag',
};

async function main(env) {
  const result = planRelease(await readRun(env));
  if (result.mode === 'nightly' || result.mode === 'stable') {
    const gaps = repositorySetupGaps(await readRepositorySetup(env));
    if (gaps.length > 0) {
      throw new Error(
        `Repository setup is incomplete (see CONTRIBUTING.md, "One-time repository setup"): ${gaps.join('; ')}.`,
      );
    }
  }
  const lines = Object.entries(OUTPUTS).map(([output, key]) => `${output}=${result[key] ?? ''}\n`);
  fs.appendFileSync(env.GITHUB_OUTPUT, lines.join(''));
  const summary = result.reason ?? `${result.mode} ${result.version}`;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Release plan: ${summary}\n`);
  process.stdout.write(`${summary}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.env);
