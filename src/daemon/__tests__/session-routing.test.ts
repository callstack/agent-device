import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { SessionStore } from '../session-store.ts';
import { resolveEffectiveSessionName, resolveSessionScope } from '../session-routing.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import type { SessionScope, SessionState } from '../session-state.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

function makeSession(name: string): SessionState {
  return {
    name,
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
}

function makeStore(t: TestContext): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-routing-');
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return new SessionStore(path.join(root, 'sessions'));
}

test('does not reuse lone active session for implicit default session from another scope', (t) => {
  const store = makeStore(t);
  store.set('android', makeSession('android'));
  const cwd = mkdtempForTestSync('agent-device-cwd-scope-');
  t.onTestFinished(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const resolved = resolveEffectiveSessionName(
    {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['com.google.android.apps.maps'],
      flags: {},
      meta: { cwd },
    },
    store,
  );

  assert.match(resolved, /^cwd:[a-f0-9]{16}:default$/);
  assert.notEqual(resolved, 'android');
});

test('uses git worktree root for implicit default session scope', (t) => {
  const root = mkdtempForTestSync('agent-device-cwd-scope-');
  const nested = path.join(root, 'packages', 'app');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(nested, { recursive: true });
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const store = makeStore(t);
  const fromRoot = resolveEffectiveSessionName(
    {
      token: 't',
      session: 'default',
      command: 'snapshot',
      positionals: [],
      flags: {},
      meta: { cwd: root },
    },
    store,
  );
  const fromNested = resolveEffectiveSessionName(
    {
      token: 't',
      session: 'default',
      command: 'snapshot',
      positionals: [],
      flags: {},
      meta: { cwd: nested },
    },
    store,
  );

  assert.equal(fromNested, fromRoot);
});

test('keeps explicitly configured default session global', (t) => {
  const store = makeStore(t);
  const cwd = mkdtempForTestSync('agent-device-cwd-scope-');
  t.onTestFinished(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const resolved = resolveEffectiveSessionName(
    {
      token: 't',
      session: 'default',
      command: 'snapshot',
      positionals: [],
      flags: {},
      meta: { cwd, sessionExplicit: true },
    },
    store,
  );

  assert.equal(resolved, 'default');
});

test('classifies every persisted session provenance without parsing its address', (t) => {
  const cwd = mkdtempForTestSync('agent-device-cwd-scope-');
  t.onTestFinished(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const request: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'open',
    positionals: ['com.example.app'],
    flags: {},
  };

  const cwdScope = resolveSessionScope({ ...request, session: 'default', meta: { cwd } });
  assert.equal(cwdScope.kind, 'cwd');
  if (cwdScope.kind === 'cwd') assert.match(cwdScope.id, /^[a-f0-9]{16}$/);
  assert.deepEqual(resolveSessionScope({ ...request, session: 'tenant-a:qa' }), {
    kind: 'named-local',
  });
  assert.deepEqual(resolveSessionScope({ ...request, session: 'default' }), {
    kind: 'global-default',
  });
  assert.deepEqual(
    resolveSessionScope({
      ...request,
      session: 'tenant-a:default',
      meta: { tenantId: 'tenant-a', sessionIsolation: 'tenant' },
    }),
    { kind: 'tenant', id: 'tenant-a' },
  );
});

function makeWorkspaceCwd(t: TestContext): { cwd: string; scopeId: string } {
  const root = mkdtempForTestSync('agent-device-cwd-scope-');
  fs.mkdirSync(path.join(root, '.git'));
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scope = resolveSessionScope({
    token: 't',
    session: 'default',
    command: 'open',
    positionals: [],
    flags: {},
    meta: { cwd: root },
  });
  assert.equal(scope.kind, 'cwd');
  if (scope.kind !== 'cwd') throw new Error('expected a cwd session scope');
  return { cwd: root, scopeId: scope.id };
}

function makeWorkspaceSession(scopeId: string, device: DeviceInfo): SessionState {
  return {
    name: 'default',
    sessionScope: { kind: 'cwd', id: scopeId } satisfies SessionScope,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'SIM-001',
  name: 'iPhone 16',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

function implicitRequest(
  cwd: string,
  flags: DaemonRequest['flags'],
  command = 'open',
): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command,
    positionals: [],
    flags: flags ?? {},
    meta: { cwd },
  };
}

test('names an implicit session by the platform it selects', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, { platform: 'ios' }), store);

  assert.equal(resolved, `cwd:${scopeId}:ios`);
});

test('gives each platform its own implicit session in one workspace', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  // #2580: binding Android from the same checkout used to be refused because the workspace
  // session was already bound to Apple.
  const resolved = resolveEffectiveSessionName(
    implicitRequest(cwd, { platform: 'android' }),
    store,
  );

  assert.equal(resolved, `cwd:${scopeId}:android`);
});

test('joins the workspace session that a named platform agrees with', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const openedWithoutPlatform = `cwd:${scopeId}:default`;
  store.set(openedWithoutPlatform, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  // Routing must keep the store key, so a platform-tagged command writes into the artifacts
  // of the session it joined instead of a second directory.
  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, { platform: 'ios' }), store);

  assert.equal(resolved, openedWithoutPlatform);
});

test('does not join a workspace session bound to another platform', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  const resolved = resolveEffectiveSessionName(
    implicitRequest(cwd, { platform: 'android', device: 'Pixel 9' }, 'boot'),
    store,
  );

  assert.equal(resolved, `cwd:${scopeId}:android`);
});

test('routes a platform-less request to the workspace sole implicit session', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const iosSession = `cwd:${scopeId}:ios`;
  store.set(iosSession, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
    attachesToSession: true,
  });

  assert.equal(resolved, iosSession);
});

test('refuses a platform-less request when the workspace holds several implicit sessions', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));
  store.set(`cwd:${scopeId}:android`, makeWorkspaceSession(scopeId, ANDROID_EMULATOR));

  assert.throws(
    () =>
      resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
        attachesToSession: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AMBIGUOUS_MATCH');
      assert.deepEqual(error.details?.sessions, [`cwd:${scopeId}:ios`, `cwd:${scopeId}:android`]);
      assert.deepEqual(error.details?.platforms, ['ios', 'android']);
      const hint = String(error.details?.hint);
      assert.match(hint, /agent-device session list/);
      assert.match(hint, /--platform ios or --platform android/);
      assert.match(hint, /--session <address>/);
      return true;
    },
  );
});

test('routes a platform-less request to a sole default-leaf session', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const openedWithoutPlatform = `cwd:${scopeId}:default`;
  store.set(openedWithoutPlatform, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
    attachesToSession: true,
  });

  assert.equal(resolved, openedWithoutPlatform);
});

test('refuses a platform-less request when a default-leaf session shares the workspace with a platform session', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  // The #2580 shape: iOS was opened without `--platform`, so it owns the `default` leaf, and
  // Android then took its own platform leaf. Preferring `default` here would run a bare `press`
  // on the iOS device the caller is no longer addressing.
  store.set(`cwd:${scopeId}:default`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));
  store.set(`cwd:${scopeId}:android`, makeWorkspaceSession(scopeId, ANDROID_EMULATOR));

  assert.throws(
    () =>
      resolveEffectiveSessionName(implicitRequest(cwd, {}, 'close'), store, {
        attachesToSession: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AMBIGUOUS_MATCH');
      const sessions = (error.details?.sessions as string[] | undefined) ?? [];
      assert.deepEqual(sessions.slice().sort(), [
        `cwd:${scopeId}:android`,
        `cwd:${scopeId}:default`,
      ]);
      assert.match(String(error.details?.hint), /--platform/);
      return true;
    },
  );
});

test('keeps inventory commands routable across implicit session ambiguity', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));
  store.set(`cwd:${scopeId}:android`, makeWorkspaceSession(scopeId, ANDROID_EMULATOR));

  // `session list` is how a caller discovers the two addresses, so it must not be refused.
  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'session_list'), store, {
    attachesToSession: false,
  });

  assert.equal(resolved, `cwd:${scopeId}:default`);
});

test('keeps a named session out of implicit workspace routing', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set('qa', { ...makeWorkspaceSession(scopeId, ANDROID_EMULATOR), sessionScope: undefined });

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
    attachesToSession: true,
  });

  assert.equal(resolved, `cwd:${scopeId}:default`);
});

test('ignores an implicit session owned by another workspace', (t) => {
  const { cwd } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set('cwd:0000000000000000:ios', makeWorkspaceSession('0000000000000000', IOS_SIMULATOR));

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
    attachesToSession: true,
  });

  assert.match(resolved, /^cwd:[a-f0-9]{16}:default$/);
});

test('leaves the requested name alone when no workspace scope resolves', (t) => {
  const store = makeStore(t);

  const resolved = resolveEffectiveSessionName(
    {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: [],
      flags: { platform: 'ios' },
    },
    store,
  );

  assert.equal(resolved, 'default');
});

test('treats an unusable platform value as no platform at all', (t) => {
  const { cwd } = makeWorkspaceCwd(t);
  const store = makeStore(t);

  const resolved = resolveEffectiveSessionName(
    implicitRequest(cwd, { platform: '../../etc/passwd' as never }),
    store,
  );

  assert.match(resolved, /^cwd:[a-f0-9]{16}:default$/);
});

test('refuses a platform selector that several implicit sessions equally answer', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));
  store.set(`cwd:${scopeId}:macos`, {
    ...makeWorkspaceSession(scopeId, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'MAC-001',
      name: 'MacBook Pro',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
  });

  // `--platform apple` matches both, and open order is not intent.
  assert.throws(
    () =>
      resolveEffectiveSessionName(implicitRequest(cwd, { platform: 'apple' }, 'press'), store, {
        attachesToSession: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'AMBIGUOUS_MATCH');
      return true;
    },
  );
});

test('prefers the session already keyed to the requested platform', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  // Both sessions answer `--platform ios`: the one keyed to it, and one opened without a platform.
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));
  store.set(
    `cwd:${scopeId}:default`,
    makeWorkspaceSession(scopeId, { ...IOS_SIMULATOR, id: 'SIM-002', name: 'iPhone 16 Plus' }),
  );

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, { platform: 'ios' }), store);

  assert.equal(resolved, `cwd:${scopeId}:ios`);
});

test('joins the session already keyed to the platform-less default leaf', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const defaultAddress = `cwd:${scopeId}:default`;
  store.set(defaultAddress, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
    attachesToSession: true,
  });

  assert.equal(resolved, defaultAddress);
});

test('keeps a same-platform device mismatch on the bound session instead of forking a second one', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const boundSession = `cwd:${scopeId}:default`;
  store.set(boundSession, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  // `--platform ios` agrees with the bound session; only the device disagrees. Routing hands the
  // request to that session so the shared selector rules refuse the mismatch, rather than opening
  // a second `--platform ios` session that would leave one label naming two sessions.
  const resolved = resolveEffectiveSessionName(
    implicitRequest(cwd, { platform: 'ios', device: 'iPad Air' }),
    store,
  );

  assert.equal(resolved, boundSession);
});

test('keeps a same-platform target mismatch on the bound session', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const boundSession = `cwd:${scopeId}:default`;
  store.set(boundSession, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  const resolved = resolveEffectiveSessionName(
    implicitRequest(cwd, { platform: 'ios', target: 'tv' }),
    store,
  );

  assert.equal(resolved, boundSession);
});

test('routes a session-lock platform into the implicit session key', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);

  // The CLI keeps a configured default platform out of `flags` when a lock policy is set, so the
  // lock's platform is the only platform this request carries while the key is being chosen.
  const request = implicitRequest(cwd, {}, 'open');

  const resolved = resolveEffectiveSessionName(
    { ...request, meta: { ...request.meta, lockPolicy: 'reject', lockPlatform: 'android' } },
    store,
  );

  assert.equal(resolved, `cwd:${scopeId}:android`);
});

test('routes a session-lock platform past a workspace session bound to another platform', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  store.set(`cwd:${scopeId}:ios`, makeWorkspaceSession(scopeId, IOS_SIMULATOR));

  // Candidate matching that reads only `flags` sees no platform here, so the iOS session appears
  // to agree and the request runs on it; the lock policy then leaves the platform unset because a
  // session is already bound, so nothing downstream corrects the choice.
  const request = implicitRequest(cwd, {}, 'press');

  const resolved = resolveEffectiveSessionName(
    { ...request, meta: { ...request.meta, lockPolicy: 'reject', lockPlatform: 'android' } },
    store,
    { attachesToSession: true },
  );

  assert.equal(resolved, `cwd:${scopeId}:android`);
});

test('counts one session reachable under two addresses once', (t) => {
  const { cwd, scopeId } = makeWorkspaceCwd(t);
  const store = makeStore(t);
  const address = `cwd:${scopeId}:ios`;
  const session = makeWorkspaceSession(scopeId, IOS_SIMULATOR);
  store.set(address, session);
  // A writer that stores by `SessionState.name` publishes the same session a second time. It must
  // not read as a second session the caller has to disambiguate.
  store.set(session.name, session);

  const resolved = resolveEffectiveSessionName(implicitRequest(cwd, {}, 'press'), store, {
    attachesToSession: true,
  });

  assert.equal(resolved, address);
});
