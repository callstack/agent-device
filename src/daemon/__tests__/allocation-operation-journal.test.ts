import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import type {
  LeaseRequestInput,
  ManagedDeviceAllocatorPort,
  SupersedeLeaseRequestInput,
} from '@agent-device/contracts/managed-device-allocation';
import type { ScriptedAllocatorMethod } from '../../__tests__/test-utils/managed-device-allocator.fixtures.ts';
import { createScriptedManagedDeviceAllocator } from '../../__tests__/test-utils/managed-device-allocator.fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  createAllocationOperationJournal,
  type AllocationBindingHooks,
} from '../allocation-operation-journal.ts';
import {
  createAllocationOperationStore,
  type AllocationOperationStore,
} from '../allocation-operation-store.ts';
import {
  ALLOCATION_GRANTED_STATUS,
  ALLOCATION_PENDING_STATUS,
  ALLOCATION_REFUSED_STATUS,
  ALLOCATION_REQUEST,
} from './allocation-operation-fixtures.ts';

const NOW = 1_700_000_000_000;

function setup(
  script: Partial<Record<ScriptedAllocatorMethod, readonly unknown[]>> = {},
  hooks?: AllocationBindingHooks,
): {
  root: string;
  store: ReturnType<typeof createAllocationOperationStore>;
  allocator: ReturnType<typeof createScriptedManagedDeviceAllocator>;
  journal: ReturnType<typeof createAllocationOperationJournal>;
} {
  const root = mkdtempForTestSync('allocation-operation-journal-');
  const store = createAllocationOperationStore({ allocationsDir: path.join(root, 'allocations') });
  const allocator = createScriptedManagedDeviceAllocator({ instanceId: 'allocator-1', script });
  const journal = createAllocationOperationJournal({
    store,
    allocator,
    binding: hooks,
    now: () => NOW,
  });
  return { root, store, allocator, journal };
}

function input(overrides: Partial<LeaseRequestInput> = {}): LeaseRequestInput {
  return { ...ALLOCATION_REQUEST, ...overrides };
}

function statusFor(overrides: Partial<typeof ALLOCATION_GRANTED_STATUS> = {}) {
  return { ...ALLOCATION_GRANTED_STATUS, ...overrides };
}

function foundRecord(
  journal: ReturnType<typeof createAllocationOperationJournal>,
  request: LeaseRequestInput = ALLOCATION_REQUEST,
) {
  const read = journal.read(request);
  assert.equal(read.status, 'found');
  return read.record;
}

function bindingHooks(
  journal: ReturnType<typeof createAllocationOperationJournal> | null = null,
  cleanupImpl?: AllocationBindingHooks['cleanup'],
): AllocationBindingHooks & { published: string[]; cleaned: string[] } {
  const published: string[] = [];
  const cleaned: string[] = [];
  return {
    published,
    cleaned,
    async publish(binding) {
      if (journal) {
        const read = journal.read(binding.operation);
        assert.equal(read.status, 'found');
        assert.equal(read.record.phase.status, 'granted');
        assert.equal(read.record.binding, 'publish-pending');
      }
      published.push(binding.lease.id);
    },
    async cleanup(binding) {
      cleaned.push(binding.lease.id);
      if (cleanupImpl) await cleanupImpl(binding);
    },
  };
}

test('persists intent before request and the allocator outcome before publishing a binding', async () => {
  const root = mkdtempForTestSync('allocation-operation-order-');
  const store = createAllocationOperationStore({ allocationsDir: path.join(root, 'allocations') });
  const scripted = createScriptedManagedDeviceAllocator({
    instanceId: 'allocator-1',
    script: { requestLease: [ALLOCATION_GRANTED_STATUS] },
  });
  const allocator: ManagedDeviceAllocatorPort = {
    ...scripted,
    async requestLease(request) {
      const read = store.read(request);
      assert.equal(read.status, 'found');
      assert.equal(read.record.phase.status, 'pending');
      return scripted.requestLease(request);
    },
  };
  const hooks: AllocationBindingHooks = {
    async publish(binding) {
      const read = store.read(binding.operation);
      assert.equal(read.status, 'found');
      assert.equal(read.record.phase.status, 'granted');
      assert.equal(read.record.binding, 'publish-pending');
    },
    async cleanup() {},
  };
  const withHooks = createAllocationOperationJournal({
    store,
    allocator,
    binding: hooks,
    now: () => NOW,
  });
  const result = await withHooks.allocate(ALLOCATION_REQUEST);
  assert.equal(result.status, 'granted');
  const record = foundRecord(withHooks);
  assert.equal(record.binding, 'published');
  assert.deepEqual(
    scripted.calls.map((call) => call.method),
    ['requestLease'],
  );
});

test('cleans a binding after publish succeeds but its durable publication state is lost', async () => {
  const root = mkdtempForTestSync('allocation-operation-publish-recovery-');
  const baseStore = createAllocationOperationStore({
    allocationsDir: path.join(root, 'allocations'),
  });
  let failPublicationStateWrite = true;
  const store: AllocationOperationStore = Object.freeze({
    ...baseStore,
    async transition(ref, expectedFence, transitionInput, nowMs) {
      if (failPublicationStateWrite && transitionInput.kind === 'binding-published') {
        failPublicationStateWrite = false;
        throw new Error('binding publication state write lost');
      }
      return baseStore.transition(ref, expectedFence, transitionInput, nowMs);
    },
  });
  const events: string[] = [];
  const hooks: AllocationBindingHooks = {
    async publish() {
      events.push('publish');
    },
    async cleanup() {
      events.push('cleanup');
    },
  };
  const scriptedAllocator = createScriptedManagedDeviceAllocator({
    instanceId: 'allocator-1',
    script: { requestLease: [ALLOCATION_GRANTED_STATUS], releaseLease: [undefined] },
  });
  const allocator: ManagedDeviceAllocatorPort = {
    ...scriptedAllocator,
    async releaseLease(input) {
      events.push('release');
      return scriptedAllocator.releaseLease(input);
    },
  };
  const journal = createAllocationOperationJournal({
    store,
    allocator,
    binding: hooks,
    now: () => NOW,
  });

  const publishResult = await journal.allocate(ALLOCATION_REQUEST);
  assert.equal(publishResult.status, 'blocked');
  assert.equal(
    publishResult.status === 'blocked' ? publishResult.reason : undefined,
    'persistence-failed',
  );
  assert.equal(foundRecord(journal).binding, 'publish-pending');

  const released = await journal.release(ALLOCATION_REQUEST);
  assert.equal(released.status, 'released');
  assert.deepEqual(events, ['publish', 'cleanup', 'release']);
  assert.deepEqual(
    scriptedAllocator.calls.map((call) => call.method),
    ['requestLease', 'releaseLease'],
  );
});

test('reconciles a lost response by lookup after reconstructing the journal', async () => {
  const first = setup({ requestLease: [new Error('connection closed')] });
  const uncertain = await first.journal.allocate(ALLOCATION_REQUEST);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(foundRecord(first.journal).phase.status, 'unknown');

  const restartedAllocator = createScriptedManagedDeviceAllocator({
    instanceId: 'allocator-1',
    script: { getLeaseRequestStatus: [ALLOCATION_GRANTED_STATUS] },
  });
  const restarted = createAllocationOperationJournal({
    store: createAllocationOperationStore({ allocationsDir: path.join(first.root, 'allocations') }),
    allocator: restartedAllocator,
    binding: bindingHooks(),
    now: () => NOW,
  });
  const recovered = await restarted.recover(ALLOCATION_REQUEST);
  assert.equal(recovered.status, 'granted');
  assert.deepEqual(
    restartedAllocator.calls.map((call) => call.method),
    ['getLeaseRequestStatus'],
  );
});

test('does not replay durable work through a different allocator instance', async () => {
  const first = setup({ requestLease: [new Error('response lost')] });
  assert.equal((await first.journal.allocate(ALLOCATION_REQUEST)).status, 'uncertain');

  const allocator = createScriptedManagedDeviceAllocator({ instanceId: 'allocator-2' });
  const restarted = createAllocationOperationJournal({
    store: createAllocationOperationStore({ allocationsDir: path.join(first.root, 'allocations') }),
    allocator,
    now: () => NOW,
  });
  const result = await restarted.recover(ALLOCATION_REQUEST);
  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' ? result.reason : undefined, 'payload-mismatch');
  assert.deepEqual(allocator.calls, []);
});

test('caller abort abandons the wait without durably cancelling allocator work', async () => {
  const controller = new AbortController();
  const scripted = createScriptedManagedDeviceAllocator({
    instanceId: 'allocator-1',
    script: { requestLease: [new Error('request aborted locally')] },
  });
  const allocator: ManagedDeviceAllocatorPort = {
    ...scripted,
    async requestLease(request) {
      controller.abort();
      return scripted.requestLease(request);
    },
  };
  const root = mkdtempForTestSync('allocation-operation-abort-');
  const store = createAllocationOperationStore({ allocationsDir: path.join(root, 'allocations') });
  const journal = createAllocationOperationJournal({ store, allocator, now: () => NOW });
  const result = await journal.allocate(input({ signal: controller.signal }));
  assert.equal(result.status, 'abandoned');
  assert.equal(foundRecord(journal).phase.status, 'pending');
  assert.deepEqual(
    scripted.calls.map((call) => call.method),
    ['requestLease'],
  );
  assert.equal(
    scripted.calls.some((call) => call.method === 'cancelLeaseRequest'),
    false,
  );
});

test('replays a durable unresolved request through its original allocator action', async () => {
  const controller = new AbortController();
  controller.abort();
  const setupResult = setup({ requestLease: [ALLOCATION_GRANTED_STATUS] }, bindingHooks());
  assert.equal(
    (await setupResult.journal.allocate(input({ signal: controller.signal }))).status,
    'abandoned',
  );
  assert.equal(foundRecord(setupResult.journal).phase.status, 'unresolved');

  const replay = await setupResult.journal.allocate(ALLOCATION_REQUEST);
  assert.equal(replay.status, 'granted');
  assert.deepEqual(
    setupResult.allocator.calls.map((call) => call.method),
    ['requestLease'],
  );
});

test('same-key replay is stable, while a new lane goes to an allocator decision', async () => {
  const secondStatus = statusFor({
    requesterId: 'requester-b',
    attemptKey: 'attempt-2',
    requestGeneration: 1,
  });
  const first = setup(
    {
      requestLease: [ALLOCATION_GRANTED_STATUS, secondStatus],
    },
    bindingHooks(),
  );
  const firstResult = await first.journal.allocate(ALLOCATION_REQUEST);
  assert.equal(firstResult.status, 'granted');
  const replay = await first.journal.allocate(ALLOCATION_REQUEST);
  assert.equal(replay.status, 'granted');
  const second = await first.journal.allocate(
    input({ requesterId: 'requester-b', attemptKey: 'attempt-2', requestGeneration: 1 }),
  );
  assert.equal(second.status, 'granted');
  assert.deepEqual(
    first.allocator.calls.map((call) => call.method),
    ['requestLease', 'requestLease'],
  );
});

test('a new key cannot replace nonterminal allocator work without explicit supersession', async () => {
  const first = setup({ requestLease: [new Error('response lost')] });
  assert.equal((await first.journal.allocate(ALLOCATION_REQUEST)).status, 'uncertain');
  const blocked = await first.journal.allocate(
    input({ attemptKey: 'attempt-2', requestGeneration: 2 }),
  );
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.status === 'blocked' ? blocked.reason : undefined, 'lane-busy');
  assert.deepEqual(
    first.allocator.calls.map((call) => call.method),
    ['requestLease'],
  );
});

test('a new key cannot reuse a stale requester generation after terminal work', async () => {
  const setupResult = setup({
    requestLease: [{ ...ALLOCATION_REFUSED_STATUS, attemptKey: 'attempt-2', requestGeneration: 2 }],
  });
  assert.equal(
    (await setupResult.journal.allocate(input({ attemptKey: 'attempt-2', requestGeneration: 2 })))
      .status,
    'refused',
  );
  const stale = await setupResult.journal.allocate(
    input({ attemptKey: 'attempt-3', requestGeneration: 1 }),
  );
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.status === 'blocked' ? stale.reason : undefined, 'payload-mismatch');
  assert.deepEqual(
    setupResult.allocator.calls.map((call) => call.method),
    ['requestLease'],
  );
});

test('explicit supersession uses the allocator and leaves both attempts durable for reconciliation', async () => {
  const replacementStatus = statusFor({ attemptKey: 'attempt-2', requestGeneration: 2 });
  const first = setup(
    {
      requestLease: [new Error('response lost')],
      supersedeLeaseRequest: [replacementStatus],
    },
    bindingHooks(),
  );
  assert.equal((await first.journal.allocate(ALLOCATION_REQUEST)).status, 'uncertain');
  const replacement: LeaseRequestInput = input({ attemptKey: 'attempt-3', requestGeneration: 3 });
  const supersede: SupersedeLeaseRequestInput = {
    requesterId: 'requester-a',
    expectedRequestGeneration: 1,
    replacement: { ...replacement, attemptKey: 'attempt-2', requestGeneration: 2 },
  };
  const third = await first.journal.supersede(supersede);
  assert.equal(third.status, 'granted');
  assert.equal(foundRecord(first.journal).phase.status, 'unknown');
  assert.equal(foundRecord(first.journal, supersede.replacement).phase.status, 'granted');
  assert.deepEqual(
    first.allocator.calls.map((call) => call.method),
    ['requestLease', 'supersedeLeaseRequest'],
  );
});

test('supersession refuses a live binding before asking the allocator to revoke it', async () => {
  const first = setup({ requestLease: [ALLOCATION_GRANTED_STATUS] }, bindingHooks());
  assert.equal((await first.journal.allocate(ALLOCATION_REQUEST)).status, 'granted');
  const replacement = input({ attemptKey: 'attempt-2', requestGeneration: 2 });
  const result = await first.journal.supersede({
    requesterId: ALLOCATION_REQUEST.requesterId,
    expectedRequestGeneration: ALLOCATION_REQUEST.requestGeneration,
    replacement,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' ? result.reason : undefined, 'already-granted');
  assert.deepEqual(
    first.allocator.calls.map((call) => call.method),
    ['requestLease'],
  );
});

test('a terminal refusal replays without re-entering the allocator', async () => {
  const setupResult = setup({ requestLease: [ALLOCATION_REFUSED_STATUS] });
  const first = await setupResult.journal.allocate(ALLOCATION_REQUEST);
  assert.equal(first.status, 'refused');
  const replay = await setupResult.journal.allocate(ALLOCATION_REQUEST);
  assert.equal(replay.status, 'refused');
  assert.deepEqual(
    setupResult.allocator.calls.map((call) => call.method),
    ['requestLease'],
  );
});

test('explicit cancellation is durable and is not confused with caller abandonment', async () => {
  const controller = new AbortController();
  controller.abort();
  const setupResult = setup({
    cancelLeaseRequest: [
      {
        requesterId: ALLOCATION_REQUEST.requesterId,
        requestGeneration: ALLOCATION_REQUEST.requestGeneration,
        attemptKey: ALLOCATION_REQUEST.attemptKey,
        state: 'cancelled',
      },
    ],
  });
  const abandonedResult = await setupResult.journal.allocate(input({ signal: controller.signal }));
  assert.equal(abandonedResult.status, 'abandoned');
  const cancelled = await setupResult.journal.cancel(ALLOCATION_REQUEST);
  assert.equal(cancelled.status, 'cancelled');
  const replay = await setupResult.journal.cancel(ALLOCATION_REQUEST);
  assert.equal(replay.status, 'cancelled');
  assert.deepEqual(
    setupResult.allocator.calls.map((call) => call.method),
    ['cancelLeaseRequest'],
  );
});

test('a late grant during explicit cancellation is durable but is never published as a success', async () => {
  const hooks = bindingHooks();
  const setupResult = setup(
    {
      requestLease: [ALLOCATION_PENDING_STATUS],
      cancelLeaseRequest: [ALLOCATION_GRANTED_STATUS],
    },
    hooks,
  );
  assert.equal((await setupResult.journal.allocate(ALLOCATION_REQUEST)).status, 'pending');
  const result = await setupResult.journal.cancel(ALLOCATION_REQUEST);
  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' ? result.reason : undefined, 'already-granted');
  assert.deepEqual(hooks.published, []);
  assert.equal(foundRecord(setupResult.journal).phase.status, 'granted');
});

test('corrupt state is retained as unreadable evidence and never implies an allocator outcome', async () => {
  const first = setup();
  const record = first.store.create({
    schemaVersion: 1,
    requesterId: ALLOCATION_REQUEST.requesterId,
    attemptKey: ALLOCATION_REQUEST.attemptKey,
    allocatorInstanceId: 'allocator-1',
    shape: ALLOCATION_REQUEST.shape,
    deadlineAtMs: ALLOCATION_REQUEST.deadlineAtMs,
    requestGeneration: ALLOCATION_REQUEST.requestGeneration,
    admission: ALLOCATION_REQUEST.admission,
    activation: ALLOCATION_REQUEST.activation,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    fence: { token: JSON.stringify(['requester-a', 'attempt-1']), generation: 0 },
    phase: { status: 'unresolved' },
    binding: 'unpublished',
    release: 'not-requested',
  });
  assert.equal(record.status, 'created');
  fs.writeFileSync(first.store.resolvePath(ALLOCATION_REQUEST), '{');
  const result = await first.journal.recover(ALLOCATION_REQUEST);
  assert.equal(result.status, 'unreadable');
  assert.equal(first.allocator.calls.length, 0);
});

test('root journal enumeration failure blocks a new allocator attempt', async () => {
  const setupResult = setup({
    requestLease: [new Error('response lost'), ALLOCATION_GRANTED_STATUS],
  });
  assert.equal((await setupResult.journal.allocate(ALLOCATION_REQUEST)).status, 'uncertain');

  const readdir = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('allocation journal root is unreadable'), { code: 'EACCES' });
  });

  try {
    const result = await setupResult.journal.allocate(
      input({ attemptKey: 'attempt-2', requestGeneration: 2 }),
    );
    assert.equal(result.status, 'unreadable');
    assert.equal(result.status === 'unreadable' ? result.reason : undefined, 'corrupt');
    assert.deepEqual(
      setupResult.allocator.calls.map((call) => call.method),
      ['requestLease'],
    );
  } finally {
    readdir.mockRestore();
  }
});

test('cleanup uncertainty blocks release until cleanup is retried, then allocator release is retryable', async () => {
  const failing = setup({ requestLease: [ALLOCATION_GRANTED_STATUS] });
  const hooks = bindingHooks(null, async () => {
    throw new Error('binding cleanup uncertain');
  });
  const withFailingCleanup = createAllocationOperationJournal({
    store: failing.store,
    allocator: failing.allocator,
    binding: hooks,
    now: () => NOW,
  });
  assert.equal((await withFailingCleanup.allocate(ALLOCATION_REQUEST)).status, 'granted');
  const cleanupPending = await withFailingCleanup.release(ALLOCATION_REQUEST);
  assert.equal(cleanupPending.status, 'cleanup-pending');
  assert.equal(
    failing.allocator.calls.some((call) => call.method === 'releaseLease'),
    false,
  );

  const restartedHooks = bindingHooks();
  const restarted = createAllocationOperationJournal({
    store: createAllocationOperationStore({
      allocationsDir: path.join(failing.root, 'allocations'),
    }),
    allocator: createScriptedManagedDeviceAllocator({
      instanceId: 'allocator-1',
      script: { releaseLease: [undefined] },
    }),
    binding: restartedHooks,
    now: () => NOW,
  });
  const released = await restarted.release(ALLOCATION_REQUEST);
  assert.equal(released.status, 'released');
  assert.deepEqual(restartedHooks.cleaned, ['lease-1']);
});

test('allocator release uncertainty remains pending and is retried after restart', async () => {
  const first = setup(
    {
      requestLease: [ALLOCATION_GRANTED_STATUS],
      releaseLease: [new Error('release response lost')],
    },
    bindingHooks(),
  );
  assert.equal((await first.journal.allocate(ALLOCATION_REQUEST)).status, 'granted');
  const uncertain = await first.journal.release(ALLOCATION_REQUEST);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(foundRecord(first.journal).release, 'pending');

  const allocator = createScriptedManagedDeviceAllocator({
    instanceId: 'allocator-1',
    script: { releaseLease: [undefined] },
  });
  const restarted = createAllocationOperationJournal({
    store: createAllocationOperationStore({ allocationsDir: path.join(first.root, 'allocations') }),
    allocator,
    binding: bindingHooks(),
    now: () => NOW,
  });
  assert.equal((await restarted.release(ALLOCATION_REQUEST)).status, 'released');
  assert.deepEqual(
    allocator.calls.map((call) => call.method),
    ['releaseLease'],
  );
});

test('a durable allocator outcome is not replaced or deleted by release replay', async () => {
  const first = setup(
    { requestLease: [ALLOCATION_GRANTED_STATUS], releaseLease: [undefined] },
    bindingHooks(),
  );
  assert.equal((await first.journal.allocate(ALLOCATION_REQUEST)).status, 'granted');
  assert.equal((await first.journal.release(ALLOCATION_REQUEST)).status, 'released');
  const pathOnDisk = first.store.resolvePath(ALLOCATION_REQUEST);
  assert.equal(fs.existsSync(pathOnDisk), true);
  const replay = await first.journal.release(ALLOCATION_REQUEST);
  assert.equal(replay.status, 'released');
  assert.deepEqual(
    first.allocator.calls.map((call) => call.method),
    ['requestLease', 'releaseLease'],
  );
});
