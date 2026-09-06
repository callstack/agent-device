import { expect, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DaemonRequest } from '../daemon-request.ts';
import type { DaemonWireRequest } from '../daemon-request-wire.ts';
import type { SessionState } from '../session-state.ts';

/**
 * `DaemonWireRequest` is the shape a consumer may read without depending on the daemon's live
 * session record — a journal, an archiver, anything that packages a request. That guarantee is
 * structural, so it is checked structurally: the assignments below fail `tsc` (not this run) the
 * moment the wire shape regains an `internal` key or grows a property path back to `SessionState`
 * or `DeviceLease`. The runtime assertions keep the file honest as a test; `pnpm typecheck` is
 * what enforces it.
 */

type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type IsAny<T> = 0 extends 1 & T ? true : false;

type Depth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Every type reachable from `T` by reading a property, calling a signature, or indexing an array,
 * bounded by `D` so a self-referential shape terminates. `any` short-circuits to `false` rather
 * than matching everything, which would make the whole walk report `boolean`.
 */
type Walk<T, Target, D extends Depth> =
  IsAny<T> extends true
    ? false
    : IsExactly<T, Target> extends true
      ? true
      : D extends 0
        ? false
        : T extends (...args: infer A) => infer R
          ? Walk<A, Target, Prev[D]> | Walk<R, Target, Prev[D]>
          : T extends ReadonlyArray<infer E>
            ? Walk<E, Target, Prev[D]>
            : T extends object
              ? { [K in keyof T]-?: Walk<Exclude<T[K], undefined>, Target, Prev[D]> }[keyof T]
              : false;

/** Whether any property path of `T` reaches `Target`. */
type Reaches<T, Target> = true extends Walk<T, Target, 8> ? true : false;

const wireHasNoInternalKey: IsExactly<Extract<keyof DaemonWireRequest, 'internal'>, never> = true;
const wireCannotReachSessionState: IsExactly<
  Reaches<DaemonWireRequest, SessionState>,
  false
> = true;
const wireCannotReachDeviceLease: IsExactly<Reaches<DaemonWireRequest, DeviceLease>, false> = true;

// Positive controls: without these, a walk that simply never finds anything would pass above.
const requestHasInternalKey: IsExactly<Extract<keyof DaemonRequest, 'internal'>, 'internal'> = true;
const requestReachesSessionState: IsExactly<Reaches<DaemonRequest, SessionState>, true> = true;
const requestReachesDeviceLease: IsExactly<Reaches<DaemonRequest, DeviceLease>, true> = true;

test('the wire request shape carries no daemon-only half', () => {
  expect([wireHasNoInternalKey, wireCannotReachSessionState, wireCannotReachDeviceLease]).toEqual([
    true,
    true,
    true,
  ]);
});

test('the daemon request shape does reach both, so the walk above can find them', () => {
  expect([requestHasInternalKey, requestReachesSessionState, requestReachesDeviceLease]).toEqual([
    true,
    true,
    true,
  ]);
});
