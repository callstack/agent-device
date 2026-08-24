import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OXFMT_BIN = path.join(REPOSITORY_ROOT, 'node_modules/oxfmt/bin/oxfmt');

export function formatGeneratedJson(value, target = 'generated.json') {
  return execFileSync(process.execPath, [OXFMT_BIN, `--stdin-filepath=${target}`], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    input: `${JSON.stringify(value, null, 2)}\n`,
  });
}
