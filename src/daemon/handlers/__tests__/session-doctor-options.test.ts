import { expect, test } from 'vitest';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { sessionChecks } from '../session-doctor-options.ts';

// The doctor's recovery command must carry each session's ADDRESS — the string `close --session`
// accepts — and dedupe by address: two cwd-scoped implicit sessions both carry the public name
// `default`, so a name compare hid them from each other and the printed
// `close --session default` addressed neither (#2031/#1394).
test('the same-device warning names the other session by its address, not its name', () => {
  const store = makeSessionStore();
  const here = 'cwd:aaaaaaaaaaaaaaaa:default';
  const other = 'cwd:bbbbbbbbbbbbbbbb:default';
  store.publish(here, makeIosSession('default'));
  store.publish(other, makeIosSession('default'));

  const [check] = sessionChecks(store, here, store.get(here));

  expect(check?.status).toBe('warn');
  expect(check?.summary).toContain(other);
  expect(check?.command).toContain(`--session ${other}`);
  expect(check?.command).not.toContain('--session default');
  expect(check?.evidence).toMatchObject({ session: here, sameDeviceSessions: [other] });
});

test('a session alone on its device passes with its own address in evidence', () => {
  const store = makeSessionStore();
  const here = 'cwd:aaaaaaaaaaaaaaaa:default';
  store.publish(here, makeIosSession('default'));

  const [check] = sessionChecks(store, here, store.get(here));

  expect(check?.status).toBe('pass');
  expect(check?.command).toBeUndefined();
  expect(check?.evidence).toMatchObject({ session: here });
});
