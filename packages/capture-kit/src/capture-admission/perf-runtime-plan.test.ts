import { describe, expect, test } from 'vitest';
import { parsePerfRuntimeRequest, resolvePerfRuntimePlan } from './perf-runtime-plan.ts';

describe('perf runtime grammar', () => {
  test('rejects flags and positionals that do not belong to frame sampling', () => {
    expect(() => parsePerfRuntimeRequest({ positionals: ['frames'], kind: 'perfetto' })).toThrow(
      'perf action must be frames',
    );
    expect(() => parsePerfRuntimeRequest({ positionals: ['frames', 'sample', 'extra'] })).toThrow(
      'perf action must be frames',
    );
  });

  test('keeps memory sample and snapshot grammars disjoint', () => {
    expect(() =>
      parsePerfRuntimeRequest({ positionals: ['memory', 'sample', 'memgraph'] }),
    ).toThrow('does not accept additional positionals');
    expect(() =>
      parsePerfRuntimeRequest({ positionals: ['memory', 'sample'], kind: 'memgraph' }),
    ).toThrow('--kind is only supported');
    expect(
      parsePerfRuntimeRequest({ positionals: ['memory', 'snapshot'], kind: 'memgraph' }),
    ).toEqual({ area: 'memory', action: 'snapshot', kind: 'memgraph' });
    expect(() =>
      parsePerfRuntimeRequest({ positionals: ['memory', 'snapshot'], kind: 'perfetto' }),
    ).toThrow('--kind must be android-hprof or memgraph');
  });

  test('maps every accepted request to its single runtime use', () => {
    expect(resolvePerfRuntimePlan(parsePerfRuntimeRequest({ positionals: ['frames'] })).kind).toBe(
      'frames',
    );
    expect(
      resolvePerfRuntimePlan(parsePerfRuntimeRequest({ positionals: ['memory', 'snapshot'] })).kind,
    ).toBe('memory-snapshot');
    expect(
      resolvePerfRuntimePlan(
        parsePerfRuntimeRequest({ positionals: ['cpu', 'profile', 'report', 'xctrace'] }),
      ).kind,
    ).toBe('profile-report');
  });
});
