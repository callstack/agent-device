import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ALL_CHECKS, selectChecks, type CheckId } from './check-affected/model.ts';

export type Selection = { run: boolean; reason: string };

type Plan = ReturnType<typeof selectChecks>;

export function checkOwnership(
  changedPaths: readonly string[] | null,
): { early: Selection; plan?: never } | { early?: never; plan: Plan } {
  if (changedPaths === null) {
    return { early: { run: true, reason: 'the PR change set could not be established' } };
  }
  if (changedPaths.length === 0) {
    return { early: { run: true, reason: 'the PR diff is empty' } };
  }
  const plan = selectChecks({ changedFiles: changedPaths });
  if (plan.failOpen) {
    return {
      early: {
        run: true,
        reason: `affected-check ownership is uncertain: ${plan.failOpenReasons[0]?.path}`,
      },
    };
  }
  return { plan };
}

// A PR runs a device lane only when the affected-check model selects one of its checks.
// Unit tests own no device lane, so a test-only PR skips every lane. Pushes run every lane.
export function selectDeviceLane(
  eventName: string,
  changedPaths: readonly string[] | null,
  checks: readonly CheckId[],
): Selection {
  if (eventName !== 'pull_request') return { run: true, reason: 'main runs exercise every lane' };
  const checked = checkOwnership(changedPaths);
  if (checked.early) return checked.early;
  const input = checked.plan.reasons.find((entry) => checks.includes(entry.check));
  return input
    ? { run: true, reason: `${input.check} input changed: ${input.path}` }
    : { run: false, reason: `the affected-check model selected none of ${checks.join(', ')}` };
}

function changedPathsFromGit(baseSha: string): string[] | null {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) return null;
  const result = spawnSync('git', ['diff', '--name-only', '-z', baseSha, 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || result.stdout === null) return null;
  return result.stdout.split('\0').filter(Boolean);
}

export function pullRequestChangedPaths(eventName: string): string[] | null {
  return eventName === 'pull_request' ? changedPathsFromGit(process.env.BASE_SHA ?? '') : [];
}

export function reportSelection(label: string, selection: Selection): void {
  process.stdout.write(`${label}: ${selection.run ? 'run' : 'skip'}; ${selection.reason}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${selection.run}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${label} selection\n\n${selection.run ? 'Run' : 'Skip'}: ${selection.reason}.\n`,
    );
  }
}

function isCheckId(value: string): value is CheckId {
  return (ALL_CHECKS as readonly string[]).includes(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const checks = process.argv.slice(2);
  if (checks.length === 0 || !checks.every(isCheckId)) {
    process.stderr.write(`Expected affected-check ids, got: ${checks.join(' ') || 'nothing'}\n`);
    process.exitCode = 2;
  } else {
    const eventName = process.env.GITHUB_EVENT_NAME ?? '';
    reportSelection(
      'Device lane',
      selectDeviceLane(eventName, pullRequestChangedPaths(eventName), checks),
    );
  }
}
