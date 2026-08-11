// `pnpm check:gate-manifest` — assert every registered gate is owned and wired.
//
// Reports every failure at once, grouped by assertion, so a rewiring round sees
// the whole picture instead of one error per run.

import { pathToFileURL } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';
import { audit } from './audit.ts';
import { loadModel } from './model.ts';

const HEADINGS: Readonly<Record<string, string>> = {
  owned: 'Registered checks no lane runs',
  bypass: 'Project code run outside `pnpm gate`',
  'lane-env': 'Lane environments that are not inventoried',
  surface: 'Execution surfaces the manifest does not model',
  'path-coverage': 'Paths whose selected checks no triggered lane runs',
  inert: 'Declarations that no longer apply',
  registered: 'Suites and projects no registered check covers',
};

function report(failures: readonly { assertion: string; message: string }[]): void {
  for (const [assertion, heading] of Object.entries(HEADINGS)) {
    const group = failures.filter((failure) => failure.assertion === assertion);
    if (group.length === 0) continue;
    process.stderr.write(`\n${heading}:\n`);
    for (const failure of group) process.stderr.write(`  - ${failure.message}\n`);
  }
  process.stderr.write(`\ngate manifest: ${failures.length} failure(s).\n`);
}

function main(): number {
  const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const tracked = runCmdSync('git', ['ls-files'], { cwd: repoRoot })
    .stdout.split('\n')
    .filter(Boolean);
  const model = loadModel(repoRoot, tracked);
  const failures = audit(model);
  if (failures.length === 0) {
    const gates = model.lanes.filter((lane) => lane.qualifying).flatMap((lane) => lane.gates);
    process.stdout.write(
      `gate manifest: ok — ${new Set(gates).size} checks wired across ` +
        `${model.lanes.filter((lane) => lane.gates.length > 0).length} lanes.\n`,
    );
    return 0;
  }
  report(failures);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
