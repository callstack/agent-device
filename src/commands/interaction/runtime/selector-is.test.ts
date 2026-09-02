import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { selector } from './selector-read-utils.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { createSelectorDevice, selectorReadSnapshot } from './__tests__/test-utils/index.ts';
import { AppError } from '@agent-device/kernel/errors';

test('runtime selectors forward public snapshot options to backend capture', async () => {
  const snapshot = selectorReadSnapshot();
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label=Continue',
    depth: 2,
    scope: 'Login',
    raw: true,
  });

  assert.deepEqual(captureOptions, {
    interactiveOnly: false,
    depth: 2,
    scope: 'Login',
    raw: true,
    includeRects: false,
  });
});

test('runtime visibility predicates request snapshot rects', async () => {
  const snapshot = selectorReadSnapshot();
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'web',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  await device.selectors.isVisible(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(captureOptions?.includeRects, true);
});

test('runtime focused predicate requests a full snapshot', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Cell',
      label: 'Profiles and Accounts',
      focused: true,
    },
  ]);
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'focused',
    selector: 'role=cell label="Profiles and Accounts"',
  });

  assert.equal(result.pass, true);
  assert.equal(captureOptions?.interactiveOnly, false);
});

test('runtime focused predicate reads focused Android TV nodes from the full tree', async () => {
  const fullSnapshot = makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'TextView',
        label: 'Featured',
        focused: true,
        hittable: false,
      },
    ],
    { backend: 'android' },
  );
  const interactiveSnapshot = makeSnapshotState([], { backend: 'android' });
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot: options?.interactiveOnly ? interactiveSnapshot : fullSnapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: interactiveSnapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'focused',
    selector: 'label=Featured',
  });

  assert.equal(result.pass, true);
  assert.equal(captureOptions?.interactiveOnly, false);
});

test('runtime is validates selector predicates', async () => {
  const device = createSelectorDevice(selectorReadSnapshot());

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label=Continue',
  });

  assert.deepEqual(result, {
    predicate: 'exists',
    pass: true,
    selector: 'label=Continue',
    matches: 1,
    selectorChain: ['label=Continue'],
  });
});

test('runtime is absent passes when the selector has no match', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([{ index: 0, depth: 0, type: 'StaticText', label: 'Current screen' }]),
  );

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'absent',
    selector: 'label="Removed row"',
  });

  assert.equal(result.predicate, 'absent');
  assert.equal(result.pass, true);
});

test('runtime is absent uses one readAny capture without requesting rects', async () => {
  const snapshot = makeSnapshotState([
    { index: 0, depth: 0, type: 'StaticText', label: 'Current screen' },
  ]);
  let captures = 0;
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        captures += 1;
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'absent',
    selector: 'label="Removed row"',
  });

  assert.deepEqual(result, {
    predicate: 'absent',
    pass: true,
    selector: 'label="Removed row"',
    matches: 0,
  });
  assert.equal(captures, 1);
  assert.equal(captureOptions?.includeRects, false);
  assert.equal(captureOptions?.depth, undefined);
  assert.equal(captureOptions?.scope, undefined);
});

test('runtime is absent reports one matching node without visibility or geometry claims', async () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'save',
      label: 'Save',
      visibleToUser: false,
    },
  ]);
  const device = createSelectorDevice(snapshot);

  await assert.rejects(
    device.selectors.is({ session: 'default', predicate: 'absent', selector: 'label="Save"' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.deepEqual(error.details, {
        command: 'is',
        reason: 'predicate_failed',
        predicate: 'absent',
        selector: 'label="Save"',
        matches: 1,
        observation: 'present',
        firstMatch: { id: 'save', role: 'button', label: 'Save' },
      });
      assert.equal(/visible|hidden|rect/i.test(error.message), false);
      return true;
    },
  );
});

test('runtime is absent reports the match count and refinement hint for multiple matches', async () => {
  const snapshot = makeSnapshotState([
    { index: 0, depth: 0, type: 'Button', identifier: 'save-one', label: 'Save' },
    { index: 1, depth: 0, type: 'Button', identifier: 'save-two', label: 'Save' },
  ]);
  const device = createSelectorDevice(snapshot);

  await assert.rejects(
    device.selectors.is({ session: 'default', predicate: 'absent', selector: 'label="Save"' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'predicate_failed');
      assert.equal(error.details?.matches, 2);
      assert.deepEqual(error.details?.firstMatch, {
        id: 'save-one',
        role: 'button',
        label: 'Save',
      });
      assert.equal(error.details?.hint, 'Refine the selector to match no elements.');
      return true;
    },
  );
});

test('runtime is absent keeps the first matching selector alternative as the readAny domain', async () => {
  const snapshot = makeSnapshotState([
    { index: 0, depth: 0, type: 'Button', identifier: 'save-one', label: 'Save' },
    { index: 1, depth: 0, type: 'Button', identifier: 'save-two', label: 'Save' },
    { index: 2, depth: 0, type: 'Button', identifier: 'gone', label: 'Gone' },
  ]);
  const device = createSelectorDevice(snapshot);

  await assert.rejects(
    device.selectors.is({
      session: 'default',
      predicate: 'absent',
      selector: 'label="Save" || label="Gone"',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'predicate_failed');
      assert.equal(error.details?.observation, 'present');
      assert.equal(error.details?.matches, 2);
      assert.deepEqual(error.details?.firstMatch, {
        id: 'save-one',
        role: 'button',
        label: 'Save',
      });
      return true;
    },
  );
});

test('runtime is absent fails closed for a sparse capture and preserves the last session snapshot', async () => {
  const initial = makeSnapshotState([{ index: 0, depth: 0, type: 'StaticText', label: 'Initial' }]);
  const sparse = makeSnapshotState([], {
    snapshotQuality: {
      state: 'sparse',
      backend: 'private-ax',
      reason: 'sparse tree',
      reasonCode: 'sparse-tree',
    },
  });
  const sessions = createMemorySessionStore([{ name: 'default', snapshot: initial }]);
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: sparse }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    device.selectors.is({ session: 'default', predicate: 'absent', selector: 'label="Gone"' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'predicate_failed');
      assert.equal(error.details?.observation, 'sparse');
      assert.equal(error.details?.matches, 0);
      assert.deepEqual(error.details?.snapshotQuality, sparse.snapshotQuality);
      return true;
    },
  );
  assert.equal((await sessions.get('default'))?.snapshot?.nodes[0]?.label, 'Initial');
});

test('runtime is absent fails closed for a truncated capture even with zero matches', async () => {
  const snapshot = makeSnapshotState([]);
  const device = createSelectorDevice(snapshot, {
    captureSnapshot: async () => ({ snapshot, truncated: true }),
  });

  await assert.rejects(
    device.selectors.is({ session: 'default', predicate: 'absent', selector: 'label="Gone"' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'predicate_failed');
      assert.equal(error.details?.observation, 'truncated');
      assert.equal(error.details?.matches, 0);
      assert.equal(error.details?.truncated, true);
      return true;
    },
  );
});

test('runtime is absent maps an unreadable capture to typed predicate failure evidence', async () => {
  const device = createSelectorDevice(makeSnapshotState([]), {
    captureSnapshot: async () => {
      throw new AppError('COMMAND_FAILED', 'accessibility capture failed', {
        reason: 'capture-failed',
      });
    },
  });

  await assert.rejects(
    device.selectors.is({ session: 'default', predicate: 'absent', selector: 'label="Gone"' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'predicate_failed');
      assert.equal(error.details?.observation, 'unreadable');
      assert.equal(error.details?.captureErrorCode, 'COMMAND_FAILED');
      assert.equal(error.details?.captureErrorReason, 'capture-failed');
      assert.equal(error.details?.matches, 0);
      return true;
    },
  );
});

test('runtime is absent refuses depth and scope before capture with typed invalid arguments', async () => {
  let captures = 0;
  const device = createSelectorDevice(makeSnapshotState([]), {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: makeSnapshotState([]) };
    },
  });

  for (const [option, value] of [
    ['scope', 'Login'],
    ['depth', 2],
  ] as const) {
    await assert.rejects(
      device.selectors.is({
        session: 'default',
        predicate: 'absent',
        selector: 'label="Gone"',
        [option]: value,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.equal(error.details?.command, 'is');
        assert.equal(error.details?.predicate, 'absent');
        assert.equal(error.details?.rejectedOption, option);
        return true;
      },
    );
  }
  assert.equal(captures, 0);
});

// Regression: admission normalizes a predicate's case, and every branch below it has to read
// the ADMITTED value. Reading `options.predicate` instead let an uppercase predicate past the
// gate and then evaluated it against lower-case branches — `EXISTS` skipped its own branch and
// `TEXT` compared nothing — so the command answered wrongly instead of refusing or working.
test('runtime is admits an upper-case predicate and evaluates it as the normalized one', async () => {
  const snapshot = makeSnapshotState([
    { index: 0, depth: 0, type: 'StaticText', label: 'Greeting' },
  ]);
  const device = createSelectorDevice(snapshot);

  const exists = await device.selectors.is({
    session: 'default',
    predicate: 'EXISTS' as 'exists',
    selector: 'label=Greeting',
  });
  assert.equal(exists.predicate, 'exists');
  assert.equal(exists.pass, true);

  const text = await device.selectors.is({
    session: 'default',
    predicate: 'TEXT' as 'text',
    selector: 'label=Greeting',
    expectedText: 'Greeting',
  });
  assert.equal(text.predicate, 'text');
  assert.equal(text.pass, true);
  assert.equal(text.text, 'Greeting');
});

test('runtime is still refuses a predicate that is not in the vocabulary', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([{ index: 0, depth: 0, type: 'StaticText', label: 'Greeting' }]),
  );

  await assert.rejects(
    async () =>
      await device.selectors.is({
        session: 'default',
        predicate: 'shiny' as 'exists',
        selector: 'label=Greeting',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.details?.hint ?? ''), /is <selector> <predicate>/);
      return true;
    },
  );
});
