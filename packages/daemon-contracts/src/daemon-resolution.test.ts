import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { answeredDaemonStateDir, resolveDaemonPaths } from './daemon-resolution.ts';

test('a relative state dir resolves against the working directory it is given', () => {
  const paths = resolveDaemonPaths('state/here', { cwd: '/workspace/project' });

  expect(paths.baseDir).toBe(path.resolve('/workspace/project', 'state/here'));
});

test('a relative state dir without a working directory is refused with a typed reason', () => {
  expect(() => resolveDaemonPaths('state/here')).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({ reason: 'relative_state_dir_without_cwd' }),
    }),
  );
});

test('an absolute state dir needs no working directory', () => {
  expect(resolveDaemonPaths('/var/agent-device/state').baseDir).toBe('/var/agent-device/state');
});

// `resolveDaemonPaths` builds every path under the state dir with `path.join`, which folds a `..` step out.
// The state-chain repair creates and judges the chain the kernel WALKS instead, so a caller that reads or
// removes what the repair wrote has to name that chain: #4584 lost the idle-expiry marker this way.
test.skipIf(process.platform === 'win32')(
  'answeredDaemonStateDir answers the walked chain, and creates nothing on the way',
  () => {
    const root = fs.realpathSync(mkdtempForTestSync('agent-device-daemon-state-answer-'));
    fs.mkdirSync(path.join(root, 'actual', 'x'), { recursive: true });
    fs.symlinkSync(path.join(root, 'actual', 'x'), path.join(root, 'alias'));
    // Spelled by hand: `path.join` would fold the step, and this is what `AGENT_DEVICE_STATE_DIR` carries.
    const stateBase = `${root}/alias/../state`;
    // The name `resolveDaemonPaths` hands out, folded, and the directory the walk arrives at.
    const spelled = path.join(root, 'state', 'sessions', 'journey');
    const walked = path.join(root, 'actual', 'state', 'sessions', 'journey');

    // Nothing below the base stands yet. The answer is still the walked chain — creation lands there — and
    // asking for it made no directory anywhere.
    expect(answeredDaemonStateDir(stateBase, spelled)).toBe(walked);
    expect(fs.readdirSync(path.join(root, 'actual', 'x'))).toEqual([]);

    // Once the chain stands, the same answer: the marker the repair wrote is the one a reader names.
    fs.mkdirSync(path.join(root, 'actual', 'state', 'sessions'), { recursive: true });
    expect(answeredDaemonStateDir(stateBase, spelled)).toBe(walked);

    // A name that is not below the base gets NO answer, so a caller keeps the name it was given instead of
    // inventing one below the verified chain — the same fallback the repair itself uses.
    expect(
      answeredDaemonStateDir(stateBase, path.join(root, 'elsewhere', 'journey')),
    ).toBeUndefined();
  },
);
