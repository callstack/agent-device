import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceLease } from '@agent-device/contracts/device';
import { expectTypeOf, test } from 'vitest';
import { buildActionEventResult } from '../session-event-action-presentation.ts';
import {
  buildRequestFinishedEvent,
  buildRequestStartedEvent,
  shouldRecordEventForRequest,
} from '../session-event-log.ts';
import {
  buildRequestSuccessEventPresentation,
  readRequestedScreenshotFileName,
} from '../session-event-request.ts';

/**
 * Every request-shaped parameter this package accepts, read off the real signatures rather than
 * restated. Widening any one of them back to the daemon's own `DaemonRequest` — the type that
 * carries `internal` with its `SessionState` callbacks and admitted `DeviceLease` — changes this
 * union, and the assertions below stop holding.
 */
type JournalRequestInput =
  | Parameters<typeof buildRequestStartedEvent>[0]['req']
  | Parameters<typeof buildRequestFinishedEvent>[0]['req']
  | Parameters<typeof shouldRecordEventForRequest>[0]
  | Parameters<typeof buildRequestSuccessEventPresentation>[0]
  | Parameters<typeof readRequestedScreenshotFileName>[0]
  | Parameters<typeof buildActionEventResult>[0];

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * Recursion budget. Six is not asserted to be deep enough by inspection: the last assertion in
 * this file walks again at twelve and requires the two answers to be identical, so a budget that
 * stopped short of some path would show up as a type the deeper walk found and this one did not.
 */
type Budget = [0, 0, 0, 0, 0, 0];

/** Twice the budget, for the saturation check. */
type DoubleBudget = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * `T`'s own declared keys, with index signatures dropped. Keeping `string` would silently absorb
 * every literal beside it in a union (`string | 'internal'` reduces to `string`), which would make
 * the assertion below vacuous the moment a `Record<string, unknown>` appears on a path — and one
 * does, at `flags`. A record that could hold an `internal` property is not a declared route to
 * session state; a declared `internal` key is.
 */
type DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: 0 };

/** Every declared property NAME reachable from `T`, arrays entered through their element type. */
type ReachableKeys<
  T,
  Cap extends readonly unknown[],
  Depth extends readonly unknown[] = [],
> = Depth['length'] extends Cap['length']
  ? never
  : [T] extends [Primitive]
    ? never
    : [T] extends [(...args: never[]) => unknown]
      ? never
      : T extends readonly (infer Element)[]
        ? ReachableKeys<Element, Cap, [...Depth, 0]>
        : T extends object
          ?
              | DeclaredKeys<T>
              | { [K in keyof T]-?: ReachableKeys<NonNullable<T[K]>, Cap, [...Depth, 0]> }[keyof T]
          : never;

/**
 * Every property TYPE reachable from `T`. Arrays are entered through their element type, and a
 * function through its PARAMETERS: that is how the daemon's `internal` actually hands out a live
 * session record (`beforeDispatch?: (session: SessionState) => …`), so a walk that treated a
 * callback as a leaf would never see the very route this file exists to reject.
 */
type ReachableTypes<
  T,
  Cap extends readonly unknown[],
  Depth extends readonly unknown[] = [],
> = Depth['length'] extends Cap['length']
  ? never
  : [T] extends [Primitive]
    ? never
    : [T] extends [(...args: never[]) => unknown]
      ? ReachableTypes<Parameters<T>, Cap, [...Depth, 0]>
      : T extends readonly (infer Element)[]
        ? Element | ReachableTypes<Element, Cap, [...Depth, 0]>
        : T extends object
          ? {
              [K in keyof T]-?:
                | NonNullable<T[K]>
                | ReachableTypes<NonNullable<T[K]>, Cap, [...Depth, 0]>;
            }[keyof T]
          : never;

/**
 * The structural minimum of `src/daemon/session-state.ts`'s `SessionState`. The package may not
 * import that module (R11), so the live session record is named by the three required fields no
 * other shape in the public request vocabulary carries together. Anything typed as `SessionState`
 * is assignable to this, which is what `Extract` needs.
 */
type LiveSessionRecord = { name: string; device: DeviceInfo; createdAt: number };

/** A callback of any arity — the form `SessionState` takes when it reaches a request. */
type AnyCallback = (...args: never[]) => unknown;

test('the journal reads a request shape with no route to daemon-private session state', () => {
  // ADR 0018's journal is durable and rendered outside the daemon. Its input is the public
  // request vocabulary of `@agent-device/kernel/contracts`: `command`, `flags`, `meta.requestId`
  // and `meta.clientArtifactPaths`. The daemon's own request type adds `internal`, whose members
  // hand out `SessionState` and an admitted `DeviceLease`; taking it here would put a live
  // session record on a path the journal could serialize.
  expectTypeOf<
    Extract<ReachableKeys<JournalRequestInput, Budget>, 'internal'>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<ReachableTypes<JournalRequestInput, Budget>, LiveSessionRecord>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<ReachableTypes<JournalRequestInput, Budget>, DeviceLease>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<ReachableTypes<JournalRequestInput, Budget>, AnyCallback>
  >().toEqualTypeOf<never>();
});

/**
 * The budget is a fixed point, not a guess. Walking again at twice the depth must reveal no key
 * and no type the six-deep walk missed; if the public request vocabulary ever grows a path deeper
 * than the budget, this fails here rather than quietly narrowing the assertions above.
 *
 * What the walk deliberately does not see: a route through an index signature. `flags` and `input`
 * are `Record<string, unknown>`, so a value stashed under a record key is invisible to a type-level
 * walk by construction — `DeclaredKeys` drops index signatures precisely so their `string` cannot
 * absorb the literal keys beside it. The claim is about DECLARED routes, which is what a type can
 * carry; a record that could hold anything is not one.
 */
test('the six-deep walk is saturated: twice the budget finds nothing more', () => {
  expectTypeOf<
    Exclude<
      ReachableKeys<JournalRequestInput, DoubleBudget>,
      ReachableKeys<JournalRequestInput, Budget>
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Exclude<
      ReachableTypes<JournalRequestInput, DoubleBudget>,
      ReachableTypes<JournalRequestInput, Budget>
    >
  >().toEqualTypeOf<never>();
});
