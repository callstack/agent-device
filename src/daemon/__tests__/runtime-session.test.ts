import { test, expect } from 'vitest';
import fs from 'node:fs';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { createDaemonRuntimeSessionStore } from '../runtime-session.ts';
import type { CommandSessionRecord } from '../../runtime-contract.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('createDaemonRuntimeSessionStore hides non-matching sessions and scopes writes', async () => {
  const previousHome = process.env.HOME;
  const tempHome = mkdtempForTestSync('agent-device-runtime-session-home-');
  const session = makeIosSession('qa-ios');
  const writes: CommandSessionRecord[] = [];
  const store = createDaemonRuntimeSessionStore({
    sessionName: 'qa-ios',
    getSession: () => session,
    recordOptions: { includeSnapshot: true },
    setRecord: (record) => {
      writes.push(record);
    },
  });

  process.env.HOME = tempHome;
  try {
    expect(await store.get('other')).toBeUndefined();
    expect(await store.get('qa-ios')).toMatchObject({ name: 'qa-ios' });

    const record = { name: 'qa-ios', appBundleId: 'com.example.app' };
    await store.set(record);
    const diagnosticsPath = await withDiagnosticsScope(
      { session: 'qa-ios', command: 'snapshot' },
      async () => {
        await store.set({ name: 'other', appBundleId: 'com.example.other' });
        return flushDiagnosticsToSessionFile({ force: true })?.path;
      },
    );

    expect(writes).toEqual([record]);
    expect(diagnosticsPath).toEqual(expect.any(String));
    const rows = fs
      .readFileSync(diagnosticsPath as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        phase: 'runtime_session_write_skipped',
        data: { expected: 'qa-ios', received: 'other' },
      }),
    );
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
