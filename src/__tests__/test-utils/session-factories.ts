import type { SessionState } from '../../daemon/types.ts';
import type {
  SessionScriptPublicationState,
  SessionScriptRepairStatus,
} from '../../daemon/session-script-publication-state.ts';
import { IOS_SIMULATOR, ANDROID_EMULATOR, MACOS_DEVICE } from './device-fixtures.ts';

/** A repair-variant `scriptPublication` literal for test setups. */
export function repairPublication(
  status: SessionScriptRepairStatus,
  opts?: { boundary?: number; path?: string; force?: boolean; sourcePath?: string },
): SessionScriptPublicationState {
  return {
    kind: 'repair',
    status,
    target:
      opts?.path !== undefined
        ? { kind: 'explicit', path: opts.path, force: opts?.force === true }
        : { kind: 'default', force: opts?.force === true },
    boundary: opts?.boundary ?? 0,
    ...(opts?.sourcePath !== undefined ? { sourcePath: opts.sourcePath } : {}),
  };
}

/** An authoring-variant `scriptPublication` literal for test setups. */
export function authoringPublication(
  status: 'armed' | 'aborted' | 'published',
  opts?: { path?: string; force?: boolean },
): SessionScriptPublicationState {
  return {
    kind: 'authoring',
    status,
    target:
      opts?.path !== undefined
        ? { kind: 'explicit', path: opts.path, force: opts?.force === true }
        : { kind: 'default', force: opts?.force === true },
  };
}

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
// The three factories below name the states a session-script session can be in.
// Since #1478 P4a those states are structural (`scriptPublication` is a tagged
// aggregate), but the factories keep naming the states production actually
// produces: ordinary recording, an ARMED-but-uncommittable repair, and the
// COMPLETE combination that publishes.
//
// A test that deliberately exercises an odd combination (a repair variant with
// no recording, say) should still build it inline.

/**
 * ADR 0016 ordinary authoring recording: the authoring lifecycle ARMED, NO
 * repair variant. This is a plain `open --save-script` / `close --save-script`
 * session, and the baseline for every authoring-side handler test (target-v1
 * evidence, parameterized fills, landmark waits) that only needs the session to
 * be recording its actions.
 *
 * ARMED is what makes it record. Recording is derived from the publication
 * lifecycle rather than stored beside it, so a session with no
 * `scriptPublication` records nothing — which is exactly what production does
 * for a session that never ran `open --save-script`.
 *
 * "Authoring", not "recording": `session.recording` is the unrelated
 * screen-capture state.
 */
export function makeAuthoringSession(
  name: string,
  overrides?: Partial<SessionState>,
): SessionState {
  return makeIosSession(name, { scriptPublication: authoringPublication('armed'), ...overrides });
}

/**
 * ADR 0012 decision 6: a session ARMED for repair by `replay --save-script` —
 * recording plus the repair variant with its boundary watermark at 0.
 *
 * ARMED, not COMPLETE: a writer handed this session ABORTS (publishes no
 * prefix) rather than committing. Use `makeRepairCompleteSession` for a
 * committable one.
 */
export function makeRepairArmedSession(
  name: string,
  overrides?: Partial<SessionState>,
): SessionState {
  return makeAuthoringSession(name, {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
    ...overrides,
  });
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
  return makeAuthoringSession(name, {
    scriptPublication: {
      kind: 'repair',
      status: 'complete',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
    ...overrides,
  });
}
