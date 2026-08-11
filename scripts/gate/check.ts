// `pnpm check:gate-manifest` — assert every registered gate is owned and wired.
//
// Reports every failure at once, grouped by assertion, so a rewiring round sees
// the whole picture instead of one error per run.

import { pathToFileURL } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';
import { audit, formatFailures, plainGateStep } from './audit.ts';
import { census, writeBaseline } from './baseline.ts';
import { loadModel } from './model.ts';

function main(): number {
  const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const tracked = runCmdSync('git', ['ls-files'], { cwd: repoRoot })
    .stdout.split('\n')
    .filter(Boolean);
  const model = loadModel(repoRoot, tracked);
  if (process.argv.includes('--update')) {
    const entries = census(model.lanes, (step) => plainGateStep(step) !== null);
    writeBaseline(entries);
    process.stdout.write(`gate manifest: baseline updated — ${entries.length} entries.\n`);
    return 0;
  }
  const failures = audit(model);
  if (failures.length === 0) {
    const gates = model.lanes.filter((lane) => lane.qualifying).flatMap((lane) => lane.gates);
    process.stdout.write(
      `gate manifest: ok — ${new Set(gates).size} checks wired across ` +
        `${model.lanes.filter((lane) => lane.gates.length > 0).length} lanes.\n`,
    );
    return 0;
  }
  process.stderr.write(formatFailures(failures));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
