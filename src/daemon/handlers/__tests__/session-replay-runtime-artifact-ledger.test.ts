import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

/**
 * #1478 P5 follow-up (one daemon-owned artifact ledger): artifact-path
 * accumulation used to be double-written — the engine's step loop kept its own
 * `Set` alongside this handler's, the two kept in sync by hand. The daemon's is
 * now the single ledger; `dispatchStep` writes it and returns its contents, and
 * the engine only threads that value.
 *
 * The ledger's one INDEPENDENT observation point is `runReplayScriptFile`'s
 * catch block: on a mid-loop throw there is no run outcome to read artifacts
 * from, so what the failure reports comes from the ledger and nothing else.
 * That makes this the counterfactual test for the threading — break the ledger
 * (drop the `dispatchStep` write, or return only the step's own entries so the
 * ledger stops accumulating) and this goes red while the ordinary
 * success/divergence paths stay green, because those read the engine's threaded
 * value instead.
 */
test('a mid-loop throw reports exactly the artifacts of the steps that ran before it', async () => {
  const root = mkdtempForTestSync('agent-device-replay-artifact-ledger-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  // Two real files, so `collectReplayActionArtifactPaths`' existence check
  // keeps them (it drops any candidate path that is not a file on disk).
  const firstArtifact = path.join(root, 'step-1.png');
  const secondArtifact = path.join(root, 'step-2.png');
  fs.writeFileSync(firstArtifact, 'artifact');
  fs.writeFileSync(secondArtifact, 'artifact');

  // Steps 1 and 2 each produce an artifact; step 3 interpolates a variable
  // nothing defines, so `resolveReplayAction` throws INVALID_ARGS from inside
  // the step loop — after two steps have already written the ledger, and
  // before step 3 dispatches anything of its own.
  const filePath = writeReplayFile(root, [
    'click "First"',
    'click "Second"',
    'click "${UNDEFINED_VAR}"',
  ]);

  const dispatched: string[] = [];
  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      const label = req.positionals?.[0] ?? '';
      dispatched.push(label);
      if (label === 'First') return { ok: true, data: { path: firstArtifact } };
      if (label === 'Second') return { ok: true, data: { path: secondArtifact } };
      throw new Error(`unexpected dispatch of ${label}`);
    },
  });

  // The throw really did land mid-loop: step 3 never reached dispatch.
  assert.deepEqual(dispatched, ['First', 'Second']);
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.match(response.error.message, /UNDEFINED_VAR/);
  // Exactly the two artifacts, in dispatch order — no more (step 3 produced
  // none), no fewer (the ledger accumulated across steps, not just the last).
  assert.deepEqual(response.error.details?.artifactPaths, [firstArtifact, secondArtifact]);
});

/**
 * The ledger's other half: a run that COMPLETES reports the same accumulation
 * through the engine's threaded value (`AdReplayRunOutcome.artifactPaths`),
 * which must agree with what the ledger holds. Pins that threading the
 * capability's return value — rather than accumulating engine-side — still
 * yields every step's artifacts, not just the final step's.
 */
test('a completed run reports every step’s artifacts through the threaded ledger value', async () => {
  const root = mkdtempForTestSync('agent-device-replay-artifact-ledger-ok-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  const firstArtifact = path.join(root, 'step-1.png');
  const secondArtifact = path.join(root, 'step-2.png');
  fs.writeFileSync(firstArtifact, 'artifact');
  fs.writeFileSync(secondArtifact, 'artifact');

  const filePath = writeReplayFile(root, ['click "First"', 'click "Second"']);

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      const label = req.positionals?.[0] ?? '';
      if (label === 'First') return { ok: true, data: { path: firstArtifact } };
      if (label === 'Second') return { ok: true, data: { path: secondArtifact } };
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.data?.artifactPaths, [firstArtifact, secondArtifact]);
});
