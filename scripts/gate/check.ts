// `pnpm check:gate-manifest` — assert every registered gate is owned and wired.
//
// Reports every failure at once, grouped by assertion, so a rewiring round sees
// the whole picture instead of one error per run.
//
// There is no `--update`: everything this command reads is either derived from the tree or
// hand-written in declarations.ts. A generated baseline is what let an earlier design
// launder a new step past review by regenerating it.

import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { audit, formatFailures } from './audit.ts';
import { MANUAL_ONLY_OWNERS, UNPROVABLE_OWNERS } from './declarations.ts';
import { loadModel } from './model.ts';

function main(): number {
  const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const tracked = runCmdSync('git', ['ls-files'], { cwd: repoRoot })
    .stdout.split('\n')
    .filter(Boolean);
  const model = loadModel(repoRoot, tracked);
  const failures = audit(model);
  if (failures.length === 0) {
    const gates = model.lanes.filter((lane) => lane.qualifying).flatMap((lane) => lane.gates);
    // Unprovable owners are reported rather than folded into the count: a check whose lane
    // this tree cannot show running should not read the same as one it can.
    const unprovable = Object.keys(UNPROVABLE_OWNERS).length;
    // Manual-only checks are named, not counted: "3 manual-only" reads like a tally, while the
    // ids read like the list of things nothing runs until someone dispatches them.
    const manual = Object.keys(MANUAL_ONLY_OWNERS).sort();
    process.stdout.write(
      `gate manifest: ok — ${new Set(gates).size} checks wired across ` +
        `${model.lanes.filter((lane) => lane.gates.length > 0).length} lanes` +
        `${unprovable > 0 ? `, ${unprovable} declared unprovable` : ''}` +
        `${manual.length > 0 ? `, manual-only: ${manual.join(', ')}` : ''}.\n`,
    );
    return 0;
  }
  process.stderr.write(formatFailures(failures));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
