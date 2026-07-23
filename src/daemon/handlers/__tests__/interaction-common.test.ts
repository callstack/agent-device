import { expect, test } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { finalizeTouchInteraction } from '../interaction-common.ts';

test('parameterized fill scrubs backend and nested settle echoes at the response boundary', () => {
  const secret = 'OpaqueValue1348';
  const placeholder = '${PASSWORD}';
  const sessionStore = makeSessionStore();
  const session = makeIosSession('parameterized-fill');
  session.recordSession = true;
  sessionStore.set(session.name, session);
  const payload = {
    text: secret,
    message: `Backend filled ${secret}`,
    selector: 'id="password"',
    selectorChain: ['id="password"', `value="${secret}" editable=true`],
    backendEcho: {
      id: secret,
      status: `accepted ${secret}`,
      nested: { kind: secret },
    },
    settle: {
      settled: true,
      waitedMs: 1,
      captures: 2,
      quietMs: 1,
      timeoutMs: 100,
      diff: {
        summary: { additions: 1, removals: 0, unchanged: 0 },
        lines: [{ kind: 'added', text: `TextField value=${secret}` }],
      },
      hint: `Observed ${secret}`,
    },
  };

  const response = finalizeTouchInteraction({
    session,
    sessionStore,
    command: 'fill',
    positionals: ['id="password"', secret],
    flags: { recordAs: 'PASSWORD' },
    result: payload,
    responseData: payload,
    actionStartedAt: 1,
    actionFinishedAt: 2,
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data).toMatchObject({
    text: placeholder,
    message: `Backend filled ${placeholder}`,
    selector: 'id="password"',
    selectorChain: ['id="password"'],
    backendEcho: {
      id: placeholder,
      status: `accepted ${placeholder}`,
      nested: { kind: placeholder },
    },
    settle: {
      diff: {
        lines: [{ kind: 'added', text: `TextField value=${placeholder}` }],
      },
      hint: `Observed ${placeholder}`,
    },
  });
  expect(JSON.stringify(response.data)).not.toContain(secret);

  const recordedResult = session.actions[0]?.result;
  expect(recordedResult).toEqual(response.data);
  expect(JSON.stringify(recordedResult)).not.toContain(secret);
});
