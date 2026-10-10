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
 *   schedule / nightly        nightly: publish main's HEAD under the `nightly` dist-tag
 *   dispatch stable on main   promote: tag the latest nightly's commit and start its stable run
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
  return run.channel === 'stable' ? planPromotion(run) : planNightly(run);
}

function planNightly(run) {
  const scheduled = run.event === 'schedule';
  const latest = latestNightlyTag([...run.tags.keys()]);
  if (scheduled && latest && run.tags.get(latest) === run.sha) {
    return skip(`${latest} already ships ${run.sha}.`);
  }
  if (scheduled && latest?.includes(`-nightly.${run.today}.`)) {
    return skip(`${latest} shipped today.`);
  }
  if (run.ciConclusion !== 'success') {
    const reason = `CI on ${run.sha} is ${run.ciConclusion}; a nightly ships only a commit whose CI passed.`;
    if (scheduled) return skip(reason);
    throw new Error(reason);
  }
  const version = nightlyVersion(run.rootVersion, run.today, run.runNumber);
  assertAheadOfStable(run, nightlyBase(version));
  return { mode: 'nightly', version, distTag: 'nightly', commit: run.sha };
}

function planPromotion(run) {
  const nightly = latestNightlyTag([...run.tags.keys()]);
  if (!nightly) throw new Error('No nightly has been published to promote.');
  const version = run.requestedVersion || nightlyBase(nightly.slice(1));
  if (!isReleaseVersion(version)) throw new Error(`${version} is not an X.Y.Z release version.`);
  if (run.tags.has(`v${version}`)) throw new Error(`v${version} is already tagged.`);
  assertAheadOfStable(run, version);
  return { mode: 'promote', version, commit: run.tags.get(nightly), nightly };
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
  const previousTag = previousReleaseTag([...run.tags.keys()], version) ?? '';
  return { mode: 'stable', version, distTag: 'latest', commit: run.sha, previousTag };
}

function skip(reason) {
  return { mode: 'skip', reason };
}

function assertAheadOfStable(run, version) {
  if (run.latestStable && compareReleaseVersions(version, run.latestStable) <= 0) {
    throw new Error(
      `${version} is not ahead of the published ${run.latestStable}. Move main's -dev version past it.`,
    );
  }
}

/** Remote tags by name, resolved to the commit each one points at. */
function remoteTags() {
  const tags = new Map();
  const output = execFileSync('git', ['ls-remote', '--tags', 'origin', 'v*'], { encoding: 'utf8' });
  for (const line of output.split('\n').filter(Boolean)) {
    const [commit, name] = line.split('\t');
    const tag = name.replace(/^refs\/tags\//, '');
    if (tag.endsWith('^{}')) tags.set(tag.slice(0, -3), commit);
    else if (!tags.has(tag)) tags.set(tag, commit);
  }
  return tags;
}

async function ciConclusion(env) {
  const { workflow_runs: runs } = await github(
    env,
    `actions/workflows/ci.yml/runs?head_sha=${env.GITHUB_SHA}&event=push&per_page=1`,
  );
  if (runs.length === 0) return 'missing';
  return runs[0].status === 'completed' ? runs[0].conclusion : runs[0].status;
}

async function isOnMain(env) {
  const { status } = await github(env, `compare/main...${env.GITHUB_SHA}`);
  return status === 'identical' || status === 'behind';
}

async function latestStable() {
  const response = await fetch('https://registry.npmjs.org/agent-device/latest');
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
  if (!response.ok) throw new Error(`GitHub API ${pathname} failed: ${response.status}`);
  return response.json();
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
    channel: env.RELEASE_CHANNEL || 'nightly',
    requestedVersion: env.RELEASE_VERSION,
    rootVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    today: new Date().toISOString().slice(0, 10).replaceAll('-', ''),
    runNumber: env.GITHUB_RUN_NUMBER,
    tags: event === 'pull_request' ? new Map() : remoteTags(),
    latestStable: onBranch || onTag ? await latestStable() : null,
    ciConclusion: onBranch ? await ciConclusion(env) : undefined,
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
  const lines = Object.entries(OUTPUTS).map(([output, key]) => `${output}=${result[key] ?? ''}\n`);
  fs.appendFileSync(env.GITHUB_OUTPUT, lines.join(''));
  const summary = result.reason ?? `${result.mode} ${result.version}`;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Release plan: ${summary}\n`);
  process.stdout.write(`${summary}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.env);
