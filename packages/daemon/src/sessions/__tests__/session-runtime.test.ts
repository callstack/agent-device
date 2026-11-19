import { expect, test } from 'vitest';
import { daemonRuntimeSchema } from '@agent-device/kernel/contracts';
import {
  openApplicationRuntimeHints,
  resolveEffectiveOpenRuntimeHints,
  toRuntimePlatform,
} from '../session-runtime.ts';

test.each(['ios', 'android', 'harmonyos'] as const)(
  '%s runtime survives wire admission and open normalization',
  (platform) => {
    const runtime = daemonRuntimeSchema.parse({ platform, launchUrl: 'demo://open' });
    expect(toRuntimePlatform(platform)).toBe(platform);
    const normalized = resolveEffectiveOpenRuntimeHints({
      req: { token: 'test', session: 'runtime-test', command: 'open', positionals: [], runtime },
      sessionName: 'runtime-test',
      platform,
      sessionStore: { getRuntimeHints: () => undefined },
    });
    expect(normalized).toMatchObject(runtime);
    expect(() =>
      resolveEffectiveOpenRuntimeHints({
        req: { token: 'test', session: 'runtime-test', command: 'open', positionals: [], runtime },
        sessionName: 'runtime-test',
        platform: platform === 'ios' ? 'android' : 'ios',
        sessionStore: { getRuntimeHints: () => undefined },
      }),
    ).toThrow();
  },
);

test('non-leaf apple selector is not a runtime platform', () => {
  expect(toRuntimePlatform('apple')).toBeUndefined();
  expect(() => daemonRuntimeSchema.parse({ platform: 'apple' })).toThrow();
});

test('openApplicationRuntimeHints pairs transport hints with the admitted apply operation', () => {
  const apply = async () => {};
  expect(openApplicationRuntimeHints({ metroHost: '10.0.2.2', metroPort: 8081 }, apply)).toEqual({
    values: { metroHost: '10.0.2.2', metroPort: '8081' },
    apply,
  });
});

test('openApplicationRuntimeHints is absent without transport hints, even when apply is missing', () => {
  expect(openApplicationRuntimeHints({ launchUrl: 'demo://open' }, undefined)).toBeUndefined();
  expect(openApplicationRuntimeHints(undefined, undefined)).toBeUndefined();
});

test('openApplicationRuntimeHints refuses transport hints without apply as an undispatched caller bug', () => {
  let caught: unknown;
  try {
    openApplicationRuntimeHints({ metroHost: '10.0.2.2', metroPort: 8081 }, undefined);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    details: { reason: 'runtime-hints-operation-missing', dispatched: 'no' },
  });
});
