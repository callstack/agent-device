import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionStore } from '../session-store.ts';
import {
  authoringPublication,
  makeAuthoringSession,
} from '../../__tests__/support/session-factories.ts';

test('teardown of an armed ordinary recording whose script write fails still retires the session', () => {
  const root = mkdtempForTestSync('agent-device-teardown-script-failure-');
  const store = new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
  const targetPath = path.join(root, 'existing.ad');
  fs.writeFileSync(targetPath, 'context platform=ios device="x"\n');
  const ref = store.publish(
    'teardown-script',
    makeAuthoringSession('teardown-script', {
      scriptPublication: authoringPublication('armed', { path: targetPath }),
      actions: [{ ts: 1, command: 'click', positionals: ['id="save"'], flags: {} }],
    }),
  );

  // Idle-reap, shutdown and lease-end teardown have no caller to report to, so the failure stays
  // in the writer's diagnostic and the session must not be leaked.
  expect(() => store.finalizeRepairTeardown(ref)).not.toThrow();
  expect(store.retire(ref)).toBe(true);
  expect(fs.readFileSync(targetPath, 'utf8')).toBe('context platform=ios device="x"\n');
});
