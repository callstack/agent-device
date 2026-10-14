import { expect, test } from 'vitest';
import { daemonRuntimeSchema } from '@agent-device/kernel/contracts';
import { resolveEffectiveOpenRuntimeHints, toRuntimePlatform } from '../session-runtime.ts';

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
