import fs from 'node:fs';
import {
  SIMPLICITY_REVIEW_HEADING,
  assessToolingSimplicity,
  hasSubstantiveSimplicityReview,
  parseNumstat,
} from './tooling-simplicity-review-model.ts';

const assessment = assessToolingSimplicity(parseNumstat(fs.readFileSync(0, 'utf8')));

if (!assessment.requiresReview) {
  process.stdout.write(
    `Simplicity review not required (${assessment.implementationAdditions} tooling implementation lines, ${assessment.testAdditions} associated test lines).\n`,
  );
  process.exit(0);
}

const body = process.env.PR_BODY ?? '';
if (hasSubstantiveSimplicityReview(body)) {
  process.stdout.write(`Simplicity review recorded: ${assessment.reasons.join('; ')}.\n`);
  process.exit(0);
}

const files = assessment.implementationFiles.map((file) => `  - ${file}`).join('\n');
process.stderr.write(
  [
    `This PR crosses the custom-tooling review tripwire: ${assessment.reasons.join('; ')}.`,
    `Add a substantive \`${SIMPLICITY_REVIEW_HEADING}\` section to the PR body.`,
    'Explain the failure being prevented, the authoritative source of truth, the simpler alternative considered, why custom enforcement is necessary, and what would trigger deletion or redesign.',
    'Implementation files counted:',
    files,
    '',
  ].join('\n'),
);
process.exitCode = 1;
