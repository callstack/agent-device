import type { SnapshotState } from '@agent-device/kernel/snapshot';

/**
 * The ADR 0014 ref-frame VALUE, declared below both `session-state.ts` (which gives the session a
 * slot to hold one) and `ref-frame.ts` (which decides which frame a session holds). Those two
 * would otherwise have to import each other, and a type cycle makes every file in the loop
 * unreadable in isolation.
 *
 * The lifetime rules, the admission matrix, and every `session.refFrame` write stay in
 * `ref-frame.ts`. This module owns only the value: what a frame IS, and the three ways one comes
 * into existence.
 */

/**
 * Issuance scope of the current frame: `all` for a complete namespace (a full
 * interactive snapshot), or the bounded set of ref bodies a partial publication
 * (`find`, settled diff, replay divergence) actually returned.
 */
export type RefFrameScope = 'all' | ReadonlySet<string>;

/** Lifecycle state of the current frame. */
export type RefFrameState = 'active' | 'expired';

type RefFrameFields = Readonly<{
  state: RefFrameState;
  scope: RefFrameScope;
  tree: SnapshotState | undefined;
  generation: number | undefined;
}>;

/**
 * One value, replaced whole by the transitions below. The class is not exported, so nothing
 * outside this file can construct, edit, or derive a frame; its ECMAScript private field also
 * makes the exported `RefFrame` nominal, so no object literal can stand in for one.
 */
class SessionRefFrame {
  readonly #fields: RefFrameFields;

  constructor(fields: RefFrameFields) {
    this.#fields = fields;
  }

  get state(): RefFrameState {
    return this.#fields.state;
  }

  get scope(): RefFrameScope {
    return this.#fields.scope;
  }

  get tree(): SnapshotState | undefined {
    return this.#fields.tree;
  }

  get generation(): number | undefined {
    return this.#fields.generation;
  }

  /** Idempotent by identity: an expired frame is returned as is, so repeated expiry compares `===`. */
  static expire(frame: SessionRefFrame): SessionRefFrame {
    if (frame.#fields.state === 'expired') return frame;
    return new SessionRefFrame({ ...frame.#fields, state: 'expired' });
  }
}

export type RefFrame = SessionRefFrame;

/**
 * The frame a session has before anything issues refs: complete authority over
 * an empty namespace, deferring tree and epoch to the operational observation.
 * A shared constant, so lineage identity is stable for a session that never
 * reached a transition.
 */
export const PRISTINE_REF_FRAME: RefFrame = new SessionRefFrame({
  state: 'active',
  scope: 'all',
  tree: undefined,
  generation: undefined,
});

/** The frame an issuance mints. Retention and epoch semantics are the caller's; see `ref-frame.ts`. */
export function issuedRefFrame(fields: {
  scope: RefFrameScope;
  tree: SnapshotState | undefined;
  generation: number | undefined;
}): RefFrame {
  return new SessionRefFrame({ state: 'active', ...fields });
}

/** The expired counterpart of `frame`, or `frame` itself when it is already expired. */
export function expiredRefFrame(frame: RefFrame): RefFrame {
  return SessionRefFrame.expire(frame);
}
