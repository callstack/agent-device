import type { SessionState } from '../../daemon/types.ts';
import { IOS_SIMULATOR, ANDROID_EMULATOR, MACOS_DEVICE } from './device-fixtures.ts';

export function makeSession(name: string, overrides?: Partial<SessionState>): SessionState {
  return {
    name,
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
    ...overrides,
  };
}

export function makeIosSession(name: string, overrides?: Partial<SessionState>): SessionState {
  return makeSession(name, { device: IOS_SIMULATOR, ...overrides });
}

export function makeAndroidSession(name: string, overrides?: Partial<SessionState>): SessionState {
  return makeSession(name, { device: ANDROID_EMULATOR, ...overrides });
}

export function makeMacOsSession(name: string, overrides?: Partial<SessionState>): SessionState {
  return makeSession(name, { device: MACOS_DEVICE, ...overrides });
}

// --- Script-authoring session states ---
//
// The three factories below name the states a session-script session can be in,
// instead of leaving each test to re-derive them from a pile of `saveScript*`
// booleans. They exist because the fields are NOT independent: `recordSession`
// without a boundary is an ordinary recording, a boundary without
// `saveScriptComplete` is an ARMED-but-uncommittable repair, and only the
// COMPLETE combination publishes. Spelling that out per test made the
// distinction the tests are actually about (ordinary vs repair, armed vs
// complete) the hardest thing to see in them.
//
// A test that deliberately exercises an odd combination (a boundary with no
// recording, say) should still build it inline — these are for the states
// production actually produces.

/**
 * ADR 0016 ordinary authoring recording: `recordSession` armed, NO repair
 * boundary. This is a plain `open --save-script` / `close --save-script`
 * session, and the baseline for every authoring-side handler test (target-v1
 * evidence, parameterized fills, landmark waits) that only needs the session to
 * be recording its actions.
 *
 * "Authoring", not "recording": `session.recording` is the unrelated
 * screen-capture state.
 */
export function makeAuthoringSession(
  name: string,
  overrides?: Partial<SessionState>,
): SessionState {
  return makeIosSession(name, { recordSession: true, ...overrides });
}

/**
 * ADR 0012 decision 6: a session ARMED for repair by `replay --save-script` —
 * recording plus the repair-run boundary watermark, which is what the writer's
 * `repairArmed` actually keys off (`saveScriptBoundary !== undefined`).
 *
 * ARMED, not COMPLETE: a writer handed this session ABORTS (publishes no
 * prefix) rather than committing. Use `makeRepairCompleteSession` for a
 * committable one.
 */
export function makeRepairArmedSession(
  name: string,
  overrides?: Partial<SessionState>,
): SessionState {
  return makeAuthoringSession(name, { saveScriptBoundary: 0, ...overrides });
}

/**
 * The same repair transaction advanced to COMPLETE — the plan reached its last
 * executable step with no outstanding divergence — so a writer commits it
 * (ARMED -> COMPLETE -> COMMITTED).
 */
export function makeRepairCompleteSession(
  name: string,
  overrides?: Partial<SessionState>,
): SessionState {
  return makeRepairArmedSession(name, { saveScriptComplete: true, ...overrides });
}
