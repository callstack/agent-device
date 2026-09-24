import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { selectChecks } from './check-affected/model.ts';

type Selection = { run: boolean; reason: string };

function checkOwnership(
  changedPaths: readonly string[] | null,
): { early: Selection; plan?: never } | { early?: never; plan: ReturnType<typeof selectChecks> } {
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

export function selectIosXctests(
  eventName: string,
  changedPaths: readonly string[] | null,
): Selection {
  if (eventName !== 'pull_request')
    return { run: true, reason: 'main and manual runs exercise XCTest' };
  const checked = checkOwnership(changedPaths);
  if (checked.early) return checked.early;
  const input = checked.plan.reasons.find((entry) => entry.check === 'swift-runner-ios');
  return input
    ? { run: true, reason: `XCTest input changed: ${input.path}` }
    : { run: false, reason: 'the affected-check model selected no iOS runner build' };
}

export function selectAppleBridgeProof(changedPaths: readonly string[] | null): Selection {
  const checked = checkOwnership(changedPaths);
  if (checked.early) return checked.early;
  const input = changedPaths.find(
    (file) => file.startsWith('apple/') || file.startsWith('packages/platform-apple/src/'),
  );
  return input
    ? { run: true, reason: `Apple implementation changed: ${input}` }
    : { run: false, reason: 'the PR changed no Apple implementation or gate tooling' };
}

function changedPathsFromGit(baseSha: string): string[] | null {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) return null;
  const result = spawnSync('git', ['diff', '--name-only', '-z', `${baseSha}...HEAD`], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || result.stdout === null) return null;
  return result.stdout.split('\0').filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = process.argv[2];
  if (target !== 'xctest' && target !== 'bridge') {
    process.stderr.write('Expected xctest or bridge target\n');
    process.exitCode = 2;
  } else {
    const eventName = process.env.GITHUB_EVENT_NAME ?? '';
    const changedPaths =
      eventName === 'pull_request' ? changedPathsFromGit(process.env.BASE_SHA ?? '') : [];
    const selection =
      target === 'xctest'
        ? selectIosXctests(eventName, changedPaths)
        : selectAppleBridgeProof(changedPaths);
    const label = target === 'xctest' ? 'iOS XCTest' : 'Apple bridge proof';
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
}
