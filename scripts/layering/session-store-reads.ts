import { execFileSync } from 'node:child_process';

const READ = String.raw`sessionStore\.(get|lookup|requireCurrent|resolveCurrent|listRefs|findByDevice|toArray)\(`;
const SOURCES = [
  'packages/*/src/**',
  ':!**/__tests__/**',
  ':!**/*.test.*',
  ':!**/fixtures/**',
  ':!**/*.fixtures.*',
  ':!packages/daemon/src/core/session-store.ts',
];

function countReads(ref?: string): number {
  try {
    return execFileSync(
      'git',
      ['grep', '-o', '-E', READ, ...(ref ? [ref] : []), '--', ...SOURCES],
      {
        encoding: 'utf8',
      },
    )
      .trimEnd()
      .split('\n').length;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return 0;
    throw error;
  }
}

const base = execFileSync(
  'git',
  ['merge-base', process.env['SESSION_STORE_READ_BASE'] || 'origin/main', 'HEAD'],
  { encoding: 'utf8' },
).trim();
const before = countReads(base);
const after = countReads();
console.log(
  `Raw sessionStore reads outside owners: ${before} → ${after} (merge base ${base.slice(0, 10)})`,
);
if (after > before) {
  console.error('Raw sessionStore reads increased. Use lifetime-bound operations.');
  process.exitCode = 1;
}
