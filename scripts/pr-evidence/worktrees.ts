// Throwaway `git worktree` checkouts for pr:evidence, with two guarantees the runner leans on:
// every worktree is registered for cleanup the moment its `add` succeeds (a later add failing
// leaks nothing), and cleanup is exhaustive — one resource's failure to be removed never skips
// the rest, and every failure is reported after the last one was attempted.

import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '../../src/utils/exec.ts';

export type WorktreeSpec = Readonly<{ name: string; commit: string }>;

function git(cwd: string, args: readonly string[]): void {
  runCmdSync('git', [...args], { cwd });
}

/**
 * Creates the requested worktrees under `scratch`, runs `fn` with their paths (in spec order),
 * and removes every worktree that was created plus `scratch` itself, whether `fn` or a later
 * `add` threw. Cleanup errors are collected and thrown together after every resource was tried.
 */
export async function withWorktrees<T, const Specs extends readonly WorktreeSpec[]>(
  repoRoot: string,
  scratch: string,
  specs: Specs,
  fn: (paths: { readonly [Index in keyof Specs]: string }) => Promise<T>,
  removeWorktree: (repoRoot: string, worktree: string) => void = defaultRemoveWorktree,
): Promise<T> {
  const created: string[] = [];
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    for (const spec of specs) {
      const worktree = path.join(scratch, spec.name);
      git(repoRoot, ['worktree', 'add', '--detach', worktree, spec.commit]);
      created.push(worktree); // registered before the next add can fail
    }
    // One path per spec, in order: the tuple type mirrors `specs` so callers destructure safely.
    outcome = {
      ok: true,
      value: await fn(created as unknown as { readonly [Index in keyof Specs]: string }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures = cleanUp(repoRoot, created, scratch, removeWorktree);
  if (failures.length > 0) {
    throw new Error(`pr-evidence cleanup left resources behind:\n${failures.join('\n')}`, {
      cause: outcome.ok ? undefined : outcome.error,
    });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Every resource is attempted; the failures come back together instead of aborting the sweep. */
function cleanUp(
  repoRoot: string,
  worktrees: readonly string[],
  scratch: string,
  removeWorktree: (repoRoot: string, worktree: string) => void,
): string[] {
  const failures: string[] = [];
  const attempt = (label: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const worktree of worktrees) attempt(worktree, () => removeWorktree(repoRoot, worktree));
  attempt(scratch, () => fs.rmSync(scratch, { recursive: true, force: true }));
  return failures;
}

function defaultRemoveWorktree(repoRoot: string, worktree: string): void {
  git(repoRoot, ['worktree', 'remove', '--force', worktree]);
}
