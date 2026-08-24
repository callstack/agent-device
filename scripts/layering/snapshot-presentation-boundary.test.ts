import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

function trackedFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--', 'packages/contracts', 'src/daemon', 'src/snapshot'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
}

test('snapshot presentation has one host facet and no daemon-owned presentation subtree', () => {
  const files = trackedFiles();
  assert.ok(
    files.includes('packages/contracts/src/snapshot-presentation.ts'),
    'the neutral presentation carrier must be owned by contracts',
  );
  assert.ok(
    files.includes('src/snapshot/snapshot-presentation/tree.ts'),
    'host-side presentation helpers must live under the snapshot facet',
  );
  assert.deepEqual(
    files.filter((file) => file.startsWith('src/daemon/snapshot-presentation/')),
    [],
    'daemon assembly must not regain a presentation-owned subtree',
  );
});
