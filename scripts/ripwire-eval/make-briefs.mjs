#!/usr/bin/env node
// Regenerates the exact per-(task, arm) briefs the agent A/B was run from.
//
// The briefs are the experiment's only variable: both arms get the same prose, the same pinned
// clone, the same rules and the same deliverable contract, and differ solely in the tooling
// paragraph read from arms/. Checking the generator in — rather than the 12 rendered files —
// keeps that invariant checkable: a brief that drifts is a diff here, not a silent one.
//
// Usage: node scripts/ripwire-eval/make-briefs.mjs --worktrees=<dir> --out=<dir> [--ripwire=<bin>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessDir, loadTasks, readArgs } from './bench-cli.mjs';

const { worktrees, out, ripwire } = readArgs({
  usage: 'make-briefs.mjs --worktrees=<dir> --out=<dir> [--ripwire=<bin>]',
  required: ['worktrees', 'out'],
  optional: { ripwire: '<path to the ripwire binary>' },
});

const ARMS = ['baseline', 'ripwire'];

const BRIEF = `# Change-set localization brief

You are localizing a change in \`agent-device\`, a large TypeScript monorepo (~4,000 files, ~33,000
symbols) checked out READ-ONLY at:

    {{WORKTREE}}

## Rules

- Work only inside that directory. Do not modify any file.
- Do NOT use git history in any form (\`git log\`, \`git show\`, \`git blame\`, \`git diff\`, \`git grep\`
  over refs). The answer is not in this repository's history and using it is cheating.
- Do NOT implement the change. Your deliverable is the CHANGE SET only.
- \`AGENTS.md\` at the repo root documents the project's own routing conventions if you want it.
- Work efficiently: a real agent pays for every byte it reads. Stop when you are confident, not
  when you are exhaustive.

## Tooling

{{ARM}}

## Task

{{PROMPT}}

## Deliverable

End your final message with exactly one fenced \`\`\`json block and nothing after it:

{"files": ["repo-relative/path.ts", "..."],
 "new_files": ["repo-relative/path.ts", "..."],
 "files_opened": ["every file you read any part of, repo-relative"],
 "tool_calls": 0,
 "notes": "one sentence on how you found them"}

- \`files\` = existing files that must be MODIFIED. \`new_files\` = files that must be CREATED.
- Include only source, test, fixture and script files. Do NOT include CHANGELOG.md or anything
  under \`website/\`.
- Precision counts as much as recall. Do not pad the list with plausible-but-untouched files.
- \`tool_calls\` must be your honest total count of tool invocations.
`;

const armText = Object.fromEntries(
  ARMS.map((arm) => [
    arm,
    readFileSync(join(harnessDir, 'arms', `${arm}.md`), 'utf8')
      .trim()
      .replaceAll('{{RIPWIRE}}', ripwire),
  ]),
);

mkdirSync(out, { recursive: true });
for (const task of loadTasks()) {
  for (const arm of ARMS) {
    const path = join(out, `${task.id}-${arm}.md`);
    writeFileSync(
      path,
      BRIEF.replace('{{WORKTREE}}', join(worktrees, task.id))
        .replace('{{ARM}}', armText[arm])
        .replace('{{PROMPT}}', task.prompt),
    );
    console.log(path);
  }
}
