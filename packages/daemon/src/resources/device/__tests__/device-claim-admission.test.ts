import { ANDROID_EMULATOR, deviceClaimFilePath } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import {
  daemonPlatformServicesFixture,
  daemonClaimRecoveryGatewayFixture,
} from '../../../__tests__/support/platform-services-fixture.ts';
import fs from 'node:fs';
import path from 'node:path';
import { localRuntimeOwner, providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { asAppError, type AppError } from '@agent-device/kernel/errors';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../../__tests__/support/device-claim-store.ts';
import { createDeviceClaimAdmission } from '../device-claim-admission.ts';
import {
  abandonDeviceClaim,
  acquireDeviceClaim,
  inspectDeviceClaims,
  canonicalLocalDeviceKey,
} from '@agent-device/daemon-contracts/device-claims';
import { createRequestExecutionScope } from '../../../server/request-execution-scope.ts';
import { resolveEffectiveSessionName } from '../../../sessions/session-routing.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { unavailableDeviceRuntimeGateway } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';
import type { DeviceClaimPolicy } from '@agent-device/command-registry/types';

const setup = isolatedDeviceClaimStores('agent-device-claim-admission-');
const localAndroid = localRuntimeOwner('android');

// `callerCwd: null` means the request carried no cwd at all (an SDK caller), which
// the default would otherwise hide: a default parameter fires on an explicit
// undefined too.
function makeAdmission(
  policy: DeviceClaimPolicy,
  stateDir: string,
  command = 'made-up-command',
  session = 'request-session',
  callerCwd: string | null = '/worktrees/current',
) {
  return createDeviceClaimAdmission({
    policy,
    command,
    session,
    workspace: callerCwd ?? '/worktrees/current',
    callerCwd: callerCwd ?? undefined,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
}

function claimedSessions(): (string | undefined)[] {
  return inspectDeviceClaims({}).map((entry) => entry.claim?.session);
}

// Enforcement is a pure function of the declared policy, not of a command name:
// an unregistered command declared `transient-exclusive` claims, and every other
// policy stays out of the claim store entirely.
const POLICY_CLAIMS: [DeviceClaimPolicy, string[]][] = [
  ['none', []],
  ['observe', []],
  ['require-owner', []],
  ['acquire-session', []],
  ['release-session', []],
  ['transient-exclusive', ['transient:made-up-command']],
];

test.for(POLICY_CLAIMS)(
  'the %s policy reaches the claim store only when transient-exclusive',
  async ([policy, held], { expect }) => {
    const { stateDir, claimsDir } = setup();
    const admission = makeAdmission(policy, stateDir);

    await admission.admit(ANDROID_EMULATOR, localAndroid);
    expect(claimedSessions()).toEqual(held);

    await admission[Symbol.asyncDispose]();
    expect(inspectDeviceClaims({})).toEqual([]);
    // A claim-free policy never even creates the store.
    if (held.length === 0) expect(fs.existsSync(claimsDir)).toBe(false);
  },
);

test('a foreign live claim refuses the command before it can reach device operations', async () => {
  const { root, stateDir } = setup();
  const ownerStateDir = path.join(root, 'foreign');
  fs.mkdirSync(ownerStateDir, { recursive: true });
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/foreign',
    stateDir: ownerStateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');
  const error = asAppError(
    await admission.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(error.details?.retriable).toBe(false);
  expect(error.details?.hint).toBe(
    'Inspect the owner with: agent-device device status --platform android --serial emulator-5554',
  );

  await admission[Symbol.asyncDispose]();
  // Disposal never touches a claim this command did not acquire.
  expect(claimedSessions()).toEqual(['owner-session']);
});

// #3345: sessions of one daemon are separate owners of a device. A claim this daemon
// holds covers a `transient-exclusive` command only when the command runs in the
// session that claim belongs to; a daemon that serves more than one session or
// worktree must not let one session install over another's device.
test('a claim this daemon holds for the same session covers the command instead of colliding with it', async () => {
  const { stateDir } = setup();
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'open-session',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'install', 'open-session');
  await admission.admit(ANDROID_EMULATOR, localAndroid);
  await admission[Symbol.asyncDispose]();

  // The session claim is untouched: the command neither replaced nor released it.
  expect(claimedSessions()).toEqual(['open-session']);
});

test('a claim this daemon holds for another session refuses the command like any live owner', async () => {
  const { stateDir } = setup();
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owning-session',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'install', 'other-session');
  const error = asAppError(
    await admission.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(error.details?.retriable).toBe(false);
  expect(error.details?.owner).toEqual({
    session: 'owning-session',
    workspace: '/worktrees/current',
    stateDir,
  });

  await admission[Symbol.asyncDispose]();
  // The refusal wrote nothing and released nothing: the owning session still holds
  // the device with its original claim.
  expect(claimedSessions()).toEqual(['owning-session']);
});

// Adopting a claim whose `transientCommand` is set hands the adopter the release token of a
// command that is still running, and disposing it unlinks a claim in use. `--session` accepts
// any name the store can sanitize, so a copy of the label is a reachable request; only the
// stored kind can tell the holder's own session from that copy.
test('an in-flight transient claim refuses a request named after its label, while a real open session of that name covers', async () => {
  const { stateDir } = setup();
  const holder = makeAdmission('transient-exclusive', stateDir, 'install', 'open-a');
  await holder.admit(ANDROID_EMULATOR, localAndroid);
  expect(claimedSessions()).toEqual(['transient:install']);

  // The intruder routes to exactly "transient:install" (an explicit `--session` does this)
  // in the holder's workspace, and asks for a DIFFERENT command so the label is not its own.
  const intruder = makeAdmission('transient-exclusive', stateDir, 'reinstall', 'transient:install');
  const error = asAppError(
    await intruder.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );
  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  await intruder[Symbol.asyncDispose]();
  // The held command still owns the device.
  expect(claimedSessions()).toEqual(['transient:install']);

  await holder[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})).toEqual([]);

  // A genuinely open session may carry that name; its claim is the session kind and covers
  // its own workspace's command.
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'transient:install',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  const own = makeAdmission('transient-exclusive', stateDir, 'install', 'transient:install');
  await own.admit(ANDROID_EMULATOR, localAndroid);
  await own[Symbol.asyncDispose]();
  expect(claimedSessions()).toEqual(['transient:install']);
});

// A claim's `session` is only a label to the code that renews a held claim, and renewing hands
// the caller that claim's release token. `install` builds the label `transient:install`, so a
// request in another session could otherwise renew an open session's claim of that name and
// delete it on release. The stored kind is what refuses it.
test("an open session named after a command's label is not renew-adopted by that command's requests", async () => {
  const { stateDir } = setup();
  const open = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'transient:install',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  expect(open.status).toBe('acquired');
  if (open.status !== 'acquired') return;

  const foreign = makeAdmission('transient-exclusive', stateDir, 'install', 'other-session');
  const error = asAppError(
    await foreign.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );
  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  await foreign[Symbol.asyncDispose]();

  // The open session's claim survived, with its original token: nothing was adopted.
  const held = inspectDeviceClaims({})[0]?.claim;
  expect(held?.ownerToken).toBe(open.ownership.ownerToken);
  expect(await abandonDeviceClaim(open.ownership)).toBe('abandoned');
});

// A legacy record carries no kind, so decoding it kindless is only safe while no kind decision
// can reach one. That decision sits behind `isClaimOwnedByThisDaemon`, which matches stateDir,
// pid, and process start time; a record this process wrote states its kind. A record that names
// this live process identity without stating a kind is therefore forged or a PID-reuse survivor,
// and here it is written by hand to pin what such a record may never do: act as a command claim.
test('a kindless legacy record under this process identity reads as the named session, never as a command claim', async () => {
  const { stateDir, claimsDir } = setup();
  fs.mkdirSync(claimsDir, { recursive: true });
  const identity = readCurrentOwnerIdentity();
  fs.writeFileSync(
    deviceClaimFilePath(canonicalLocalDeviceKey(ANDROID_EMULATOR)),
    JSON.stringify({
      schemaVersion: 2,
      deviceKey: canonicalLocalDeviceKey(ANDROID_EMULATOR),
      device: {
        family: 'android',
        id: ANDROID_EMULATOR.id,
        name: ANDROID_EMULATOR.name,
        kind: ANDROID_EMULATOR.kind,
      },
      session: 'transient:install',
      workspace: '/worktrees/current',
      stateDir,
      ownerPid: identity.pid,
      ownerStartTime: identity.startTime,
      ownerToken: 'legacy-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );

  // Another session's `install` must not adopt or renew it: the label guard refuses outright.
  const foreign = makeAdmission('transient-exclusive', stateDir, 'install', 'other-session');
  const error = asAppError(
    await foreign.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );
  expect(error.code).toBe('DEVICE_IN_USE');
  await foreign[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})[0]?.claim?.ownerToken).toBe('legacy-token');

  // Addressed as the name itself from the claim's workspace, it covers like the v3 colon-named
  // session's claim does — the schema version alone decides nothing about the kind.
  const named = makeAdmission('transient-exclusive', stateDir, 'install', 'transient:install');
  await named.admit(ANDROID_EMULATOR, localAndroid);
  await named[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})[0]?.claim?.ownerToken).toBe('legacy-token');
});

// Binding dedupes a request's devices by `deviceIdentityKey`, which carries `target`, while the
// claim key is the narrower `canonicalLocalDeviceKey`, so one device can reach admission twice.
// A claim this request took is the only claim that covers the second pass; anything else must
// still refuse rather than be adopted on the token this request wrote.
test('a transient claim this request took covers re-admitting the same device', async () => {
  const { stateDir } = setup();
  const admission = makeAdmission('transient-exclusive', stateDir, 'install', 'request-session');
  await admission.admit(ANDROID_EMULATOR, localAndroid);
  expect(claimedSessions()).toEqual(['transient:install']);

  // Android TV is a distinct form-factor leaf: same family/id, so the same claim
  // key, while the identity key carries the target and binding treats them apart.
  await admission.admit({ ...ANDROID_EMULATOR, target: 'tv' }, localAndroid);
  await admission[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})).toEqual([]);
});

// Session addresses are printed by `device status` and re-enter through `--session`, so
// coverage has to compare what the claim records, not the string it carries. Both sides go
// through the same canonicalization the router hashes into an implicit address, so one
// checkout stays one workspace across its directories.
test("a claim at this workspace's implicit address still covers its own workspace's command", async () => {
  const { root, stateDir } = setup();
  const workspace = path.join(root, 'worktree');
  const subdirectory = path.join(workspace, 'packages', 'app');
  fs.mkdirSync(subdirectory, { recursive: true });
  // The canonical root is the git worktree root, which is what makes the two
  // directories one workspace; without a checkout the two are just two paths.
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'cwd:aaa111:android',
    workspace,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  // The owner issues `install` from a subdirectory: raw cwd comparison would refuse it.
  const admission = makeAdmission(
    'transient-exclusive',
    stateDir,
    'install',
    'cwd:aaa111:android',
    subdirectory,
  );
  await admission.admit(ANDROID_EMULATOR, localAndroid);
  await admission[Symbol.asyncDispose]();
  expect(claimedSessions()).toEqual(['cwd:aaa111:android']);
});

test('naming another workspace\u2019s session address does not cover a transient command', async () => {
  const { root, stateDir } = setup();
  const ownerWorkspace = path.join(root, 'worktree-a');
  const foreignWorkspace = path.join(root, 'worktree-b');
  fs.mkdirSync(ownerWorkspace, { recursive: true });
  fs.mkdirSync(foreignWorkspace, { recursive: true });
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'cwd:aaa111:android',
    workspace: ownerWorkspace,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission(
    'transient-exclusive',
    stateDir,
    'install',
    'cwd:aaa111:android',
    foreignWorkspace,
  );
  const error = asAppError(
    await admission.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.owner).toMatchObject({ session: 'cwd:aaa111:android' });
  await admission[Symbol.asyncDispose]();
  expect(claimedSessions()).toEqual(['cwd:aaa111:android']);
});

// A request without a cwd (SDK callers) cannot prove a workspace either way, so the
// workspace check stays out rather than refusing against the daemon's own directory.
test('a request that carries no cwd keeps coverage of its session\u2019s claim', async () => {
  const { stateDir } = setup();
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'sdk-session',
    workspace: '/somewhere/else',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'install', 'sdk-session', null);
  await admission.admit(ANDROID_EMULATOR, localAndroid);
  await admission[Symbol.asyncDispose]();
  expect(claimedSessions()).toEqual(['sdk-session']);
});

// A transient claim outlives its request when the release unlink fails, and a live survivor now
// refuses its own session's next command. The recovery is to abandon the record the unlink left
// behind, which is the state acquireTransientDeviceClaim already supersedes.
test('a failed release abandons the claim so the next command is not locked out', async () => {
  const { stateDir } = setup();
  const admission = makeAdmission('transient-exclusive', stateDir, 'install', 'own-session');
  await admission.admit(ANDROID_EMULATOR, localAndroid);
  expect(claimedSessions()).toEqual(['transient:install']);

  // The fault lands on the one unlink the release needs: the owned claim file.
  // Everything else — including the process lock's reclaim-mutex unlinks taken on
  // the way in and out — forwards to the real implementation.
  const claimPath = deviceClaimFilePath(canonicalLocalDeviceKey(ANDROID_EMULATOR));
  const originalUnlink = fs.unlinkSync;
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (String(target) === claimPath) {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    }
    return originalUnlink(target as Parameters<typeof fs.unlinkSync>[0]);
  });
  try {
    await admission[Symbol.asyncDispose]();
  } finally {
    unlink.mockRestore();
  }

  // The claim survived the failed unlink as abandoned, not live: a live survivor would
  // refuse this session's next install.
  const survivor = inspectDeviceClaims({});
  expect(survivor.map((entry) => entry.claim?.session)).toEqual(['transient:install']);
  expect(survivor[0]?.claim?.abandonedAtMs).toBeTypeOf('number');

  const retry = makeAdmission('transient-exclusive', stateDir, 'install', 'own-session');
  await retry.admit(ANDROID_EMULATOR, localAndroid);
  expect(claimedSessions()).toEqual(['transient:install']);
  await retry[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})).toEqual([]);
});

test("an abandoned claim becomes this command's own transient claim and is released", async () => {
  const { stateDir } = setup();
  const aborted = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'aborted-open',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  expect(aborted.status).toBe('acquired');
  if (aborted.status !== 'acquired') return;
  expect(await abandonDeviceClaim(aborted.ownership)).toBe('abandoned');

  const admission = makeAdmission('transient-exclusive', stateDir, 'install');
  await admission.admit(ANDROID_EMULATOR, localAndroid);

  // Coverage would have left the abandoned record owning the device with nothing to release it.
  expect(claimedSessions()).toEqual(['transient:install']);
  await admission[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})).toEqual([]);
});

test('a provider-owned device takes no host-local claim', async () => {
  const { stateDir, claimsDir } = setup();
  const admission = makeAdmission('transient-exclusive', stateDir);

  await admission.admit(ANDROID_EMULATOR, providerRuntimeOwner('limrun', 'instance-1'));
  await admission[Symbol.asyncDispose]();

  expect(fs.existsSync(claimsDir)).toBe(false);
});

test.for(POLICY_CLAIMS.map(([policy]) => policy))(
  'a provider owner never claims under the %s policy',
  async (policy, { expect }) => {
    const { stateDir, claimsDir } = setup();
    const admission = makeAdmission(policy, stateDir);

    await admission.admit(ANDROID_EMULATOR, providerRuntimeOwner('limrun', 'instance-1'));
    await admission[Symbol.asyncDispose]();
    expect(fs.existsSync(claimsDir)).toBe(false);
  },
);

// A record of a schema version this daemon does not read is not provably free: it refuses
// ordinary admission rather than being overwritten as if the device were unclaimed.
test('an ordinary owner is refused for an unknown-schema claim record, not waved through', async () => {
  const { stateDir, claimsDir } = setup();
  fs.mkdirSync(claimsDir, { recursive: true });
  const deviceKey = canonicalLocalDeviceKey(ANDROID_EMULATOR);
  const claimPath = deviceClaimFilePath(deviceKey);
  const record = JSON.stringify({
    schemaVersion: 4,
    deviceKey,
    device: {
      family: 'android',
      id: ANDROID_EMULATOR.id,
      name: ANDROID_EMULATOR.name,
      kind: ANDROID_EMULATOR.kind,
    },
    session: 'future',
    workspace: '/worktrees/future',
    stateDir: '/state/future',
    ownerPid: 4242,
    ownerStartTime: 'start',
    ownerToken: 'token',
    createdAtMs: 1,
    updatedAtMs: 2,
  });
  fs.writeFileSync(claimPath, record);
  const admission = makeAdmission('transient-exclusive', stateDir);

  const error = asAppError(
    await admission.admit(ANDROID_EMULATOR, localAndroid).catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_OWNER_UNCERTAIN');
  expect(error.details?.classification).toBe('inconsistent');
  await admission[Symbol.asyncDispose]();
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(record);
});

test('the none policy still reaches no device state at all', async () => {
  const { root, stateDir, claimsDir } = setup();
  const ownerStateDir = path.join(root, 'foreign');
  fs.mkdirSync(ownerStateDir, { recursive: true });
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/foreign',
    stateDir: ownerStateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  const before = fs.readdirSync(claimsDir);

  const admission = makeAdmission('none', stateDir);
  await admission.admit(ANDROID_EMULATOR, localAndroid);
  await admission[Symbol.asyncDispose]();

  expect(fs.readdirSync(claimsDir)).toEqual(before);
});

/** What one command sees when it binds a device through the real request scope. */
async function bindInRequestSession(params: {
  command: string;
  stateDir: string;
  session?: string;
  cwd?: string;
}): Promise<{ claims: (string | undefined)[]; error?: AppError }> {
  const scope = await createRequestExecutionScope({
    platformServices: daemonPlatformServicesFixture(),
    claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
    req: {
      token: 't',
      session: params.session ?? '',
      command: params.command,
      positionals: [],
      flags: {},
      meta: params.cwd ? { cwd: params.cwd } : undefined,
    },
    sessionStore: new SessionStore(path.join(params.stateDir, 'sessions')),
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
    platformRequestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  try {
    await scope.bindDevice(ANDROID_EMULATOR, {
      required: [],
      preferred: [],
    });
    return { claims: claimedSessions() };
  } catch (error) {
    return { claims: claimedSessions(), error: asAppError(error) };
  } finally {
    await scope[Symbol.asyncDispose]();
  }
}

test('the request scope claims only for commands whose descriptor declares transient-exclusive', async () => {
  const { stateDir } = setup();

  // Same binding call, same device: the difference is the descriptor policy.
  expect(
    (await bindInRequestSession({ command: 'shutdown', stateDir, session: 'default' })).claims,
  ).toEqual(['transient:shutdown']);
  expect(
    (await bindInRequestSession({ command: 'snapshot', stateDir, session: 'default' })).claims,
  ).toEqual([]);
  expect(inspectDeviceClaims({})).toEqual([]);
});

// `--session transient:install` is a legal explicit name — the store sanitizes only directory
// segments — so the router hands admission that exact address. It must not read as the owner of
// a command claim that is still in flight, and the refusal must leave that command holding the
// device.
test('the request scope refuses a session addressed by a transient label while a command holds the device', async () => {
  const { stateDir } = setup();
  const holder = makeAdmission('transient-exclusive', stateDir, 'install', 'open-a');
  await holder.admit(ANDROID_EMULATOR, localAndroid);

  const intruder = await bindInRequestSession({
    command: 'reinstall',
    stateDir,
    session: 'transient:install',
  });
  expect(intruder.error?.code).toBe('DEVICE_IN_USE');
  expect(intruder.error?.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(intruder.claims).toEqual(['transient:install']);

  await holder[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})).toEqual([]);
});

test('the request scope admits a transient command only in the session whose claim owns the device', async () => {
  const { stateDir } = setup();
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owning-session',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const owner = await bindInRequestSession({
    command: 'install',
    stateDir,
    session: 'owning-session',
  });
  expect(owner.error).toBeUndefined();
  expect(owner.claims).toEqual(['owning-session']);

  const intruder = await bindInRequestSession({
    command: 'install',
    stateDir,
    session: 'intruder-session',
  });
  expect(intruder.error?.code).toBe('DEVICE_IN_USE');
  expect(intruder.error?.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(intruder.error?.details?.owner).toMatchObject({ session: 'owning-session' });
  expect(intruder.claims).toEqual(['owning-session']);
});

// Coverage must compare the claim against the *routed* session address, not the requested
// name: an implicit CLI request carries no name, and its claim lives at the workspace's
// implicit address. Passing the bare request name here would refuse the owner's own
// install on every real CLI session.
test('the request scope covers the implicit workspace session that routed to the claim', async () => {
  const { root, stateDir } = setup();
  const workspace = path.join(root, 'worktree');
  const elsewhere = path.join(root, 'other-worktree');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'));
  const routedAddress = resolveEffectiveSessionName(
    {
      token: 't',
      session: '',
      command: 'install',
      positionals: [],
      flags: {},
      meta: { cwd: workspace },
    },
    sessionStore,
    { attachesToSession: true },
  );
  // The point of the pin: the owning address is not the name the request carried.
  expect(routedAddress).not.toBe('default');
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: routedAddress,
    workspace,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const owner = await bindInRequestSession({ command: 'install', stateDir, cwd: workspace });
  expect(owner.error).toBeUndefined();
  expect(owner.claims).toEqual([routedAddress]);

  const intruder = await bindInRequestSession({ command: 'install', stateDir, cwd: elsewhere });
  expect(intruder.error?.code).toBe('DEVICE_IN_USE');
  expect(intruder.error?.details?.owner).toMatchObject({ session: routedAddress });
  expect(intruder.claims).toEqual([routedAddress]);
});
