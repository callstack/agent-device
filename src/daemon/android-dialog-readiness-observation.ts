import { readSessionRuntimeRevision } from './ref-frame.ts';
import type { SessionState } from './types.ts';

/**
 * The last time a session's device was observed to show NO blocking system dialog.
 *
 * Every guarded command probes the device twice — once before dispatch and once after — so a run
 * of commands repeats the previous command's post-dispatch probe as the next command's pre-dispatch
 * probe with nothing but host time in between. This records the post-dispatch answer so the repeat
 * can be served without another `dumpsys` spawn.
 *
 * Two conditions keep the record from ever hiding a dialog:
 *
 *  - The session's runtime revision must be unchanged. That counter (`ref-frame.ts`) advances at
 *    EVERY device side-effect seam under ADR 0014, so any command that could have provoked a dialog
 *    invalidates the record by construction. There is no argv allowlist to keep in sync, and a new
 *    mutating path is covered the moment it expires the ref frame like every other one.
 *  - The record must be younger than {@link ANDROID_DIALOG_READINESS_OBSERVATION_TTL_MS}. A system
 *    ANR can surface with no adb traffic at all, so revision equality alone is not enough.
 *
 * Only the `after-command` phase writes an observation the next command may reuse, and only the
 * `before-command` phase reads one. A post-dispatch check therefore always re-observes the device,
 * whether or not the dispatch it followed expired the frame — the ANR-appeared-after-the-command
 * detection cannot be skipped by a path that forgets to declare its side effect.
 */
export const ANDROID_DIALOG_READINESS_OBSERVATION_TTL_MS = 1_000;

type AndroidDialogReadinessObservation = {
  revision: number;
  observedAt: number;
};

const observations = new WeakMap<SessionState, AndroidDialogReadinessObservation>();

export function recordAndroidDialogReadinessObservation(session: SessionState): void {
  observations.set(session, {
    revision: readSessionRuntimeRevision(session),
    observedAt: Date.now(),
  });
}

export function isAndroidDialogReadinessObserved(session: SessionState): boolean {
  const observation = observations.get(session);
  if (!observation) return false;
  if (observation.revision !== readSessionRuntimeRevision(session)) return false;
  return Date.now() - observation.observedAt < ANDROID_DIALOG_READINESS_OBSERVATION_TTL_MS;
}
