import { expect, test } from 'vitest';
import {
  makeIosSession,
  authoringPublication,
} from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';

test('recording replay fixtures use the selected scoped journal without a public-name slot', async () => {
  const store = makeSessionStore();
  const address = 'cwd:recording-fixture:default';
  const ref = store.publish(
    address,
    makeIosSession('default', {
      scriptPublication: authoringPublication('armed'),
    }),
  );
  const invoke = makeRecordingReplayInvoke({ sessionStore: store, sessionName: address });
  expect(
    await invoke({
      token: 'test',
      session: 'default',
      command: 'click',
      positionals: ['1', '2'],
      flags: {},
    }),
  ).toMatchObject({ ok: true });
  await store.flushEvents();
  expect(store.requireCurrent(ref).actions).toHaveLength(1);
  expect(store.readEvents(address).events).toHaveLength(1);
  expect(store.lookup('default')).toBeUndefined();
  expect(store.readEvents('default').events).toEqual([]);
});
