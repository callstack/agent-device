export const ALERT_POLL_INTERVAL_MS = 300;
export const DEFAULT_ALERT_TIMEOUT_MS = 10_000;
export const ALERT_ACTION_RETRY_MS = 2_000;

/**
 * The largest alert budget the legs accept. The window signal rides `AbortSignal.timeout`, whose
 * Node ceiling is 2^31-1 ms: larger values are rejected outright there, and its underlying timer
 * overflows to a 1 ms firing when merely exceeded. The daemon refuses a larger `alert wait`
 * budget as `INVALID_ARGS`, and a tree driver reads one as the bounded default — never a
 * silently shortened window.
 */
export const MAX_ALERT_WINDOW_MS = 2_147_483_647;

/**
 * The one alert failure the family retries on: the backend looked and there was no alert *yet*.
 * Both Apple backends state it in typed form — the XCTest runner as this `ErrorPayload.code`
 * (surfacing as `details.runnerErrorCode`, like `RUNNER_BUSY`, without changing the wire error
 * code), the macOS helper as details.reason — and so do the tree-based acting legs (Android and
 * Limrun iOS, through the shared driver), as this `details.reason` paired with `dispatched:
 * 'no'`. Retry and the fallback hint key on these, never on the message text: a transport,
 * runner or helper failure must never read as an absent alert.
 */
export const ALERT_NOT_FOUND_RUNNER_CODE = 'ALERT_NOT_FOUND';
export const ALERT_NOT_FOUND_REASON = 'alert-not-found';

/**
 * The Apple XCUITest runner refused an `accept`/`dismiss` because no button on the alert fits
 * the action: `dismiss` found no label on its decline list, and tapping anything else could
 * answer an affirmative (#3627). The refusal is made in the button choice, before any
 * activation, so it discloses `dispatched: no` like the other replies that ran nothing.
 */
export const ALERT_BUTTON_NOT_FOUND_RUNNER_CODE = 'ALERT_BUTTON_NOT_FOUND';

/**
 * The acting leg's confirm budget ran out after a press landed without settling whether the
 * alert is gone: the dialog was seen standing again after the press ("did not dismiss"), or no
 * post-press read ever resolved to an answer ("could not be confirmed"). Typed so a caller can
 * tell "a press went out and the screen never proved it worked" from absence or an
 * unresolvable capture. The lookup never answers with it — a budget ends its loop, it does not
 * cancel a started capture — so a quiet screen is always `alert-not-found`.
 */
export const ALERT_WINDOW_EXPIRED_REASON = 'alert-window-expired';

/** What an `alert get` capture resolved to, typed so clients switch on states, not messages. */
export type AlertStatusKind = 'visible' | 'none' | 'undecided';

export type AlertButtonRole = 'accept' | 'dismiss' | 'neutral';

/**
 * What one capture from a tree-based alert backend says about alerts. `none` states absence;
 * `undecided` states the capture is alert-shaped yet unresolvable (a degraded or shared root,
 * competing sheets) and proves nothing — confirming a dismissal may accept `none`, never
 * `undecided`. Backends whose capture cannot reach `undecided` report a quiet capture as `none`.
 */
export type AlertCapture<TCandidate> =
  | { kind: 'alert'; candidate: TCandidate }
  | { kind: 'none' }
  | { kind: 'undecided' };

/**
 * The one alert button label vocabulary every tree-based alert backend classifies with,
 * declared as a per-role preference table: each entry names one English label (regex only for
 * spelling variants of the *same* label), earlier entries outrank later ones, so a sheet
 * offering several grants resolves by declared preference ("while using the app" over "only
 * this time") instead of tree order. The table ranks labels, not buttons it cannot read: a
 * backend owning a fact no label carries — Android's permission-grant ids — supplies its own
 * rank per candidate, and the label table ranks only where the backend declares nothing.
 * Buttons neither the vocabulary nor a backend rank reaches stay neutral, and acting legs
 * refuse on the button-undecided reason rather than guessing at a translation.
 */
const ACCEPT_LABEL_PREFERENCES: readonly RegExp[] = [
  /^allow while using (?:the )?app$/i,
  /^while using the app$/i,
  /^allow all$/i,
  /^always allow$/i,
  /^allow all the time$/i,
  /^allow notifications$/i,
  /^allow$/i,
  /^ok$/i,
  /^yes$/i,
  /^continue$/i,
  /^save$/i,
  /^confirm$/i,
  /^turn on$/i,
  /^open settings$/i,
  // One-time grants last: a sheet offering a lasting grant should not spend the tap here.
  /^allow once$/i,
  /^only this time$/i,
];
// `don.?t allow` covers the straight, missing, and typographic apostrophe in one alternate.
const DISMISS_LABEL_PREFERENCES: readonly RegExp[] = [
  /^cancel$/i,
  /^deny$/i,
  /^don.?t allow$/i,
  /^not now$/i,
  /^no$/i,
  /^dismiss$/i,
  /^close$/i,
  /^close app$/i,
  /^later$/i,
  /^skip$/i,
  /^ask app not to track$/i,
];

const LABEL_PREFERENCES: Record<'accept' | 'dismiss', readonly RegExp[]> = {
  accept: ACCEPT_LABEL_PREFERENCES,
  dismiss: DISMISS_LABEL_PREFERENCES,
};

/** One button's action role under the shared vocabulary; anything unnamed is neutral. */
export function classifyAlertButtonRole(label: string): AlertButtonRole {
  const trimmed = label.trim();
  if (ACCEPT_LABEL_PREFERENCES.some((pattern) => pattern.test(trimmed))) return 'accept';
  if (DISMISS_LABEL_PREFERENCES.some((pattern) => pattern.test(trimmed))) return 'dismiss';
  return 'neutral';
}

/**
 * A role-named button's place in the declared preference table, or null when its label carries
 * no vocabulary entry (localized grants, unnamed choices).
 */
function alertButtonPreferenceRank(label: string, role: 'accept' | 'dismiss'): number | null {
  const index = LABEL_PREFERENCES[role].findIndex((pattern) => pattern.test(label.trim()));
  return index === -1 ? null : index;
}

/**
 * The one choice boundary for a shared choice: pick the action's role candidates by declared
 * preference. Each candidate's rank comes from the owning backend first — a backend may own
 * facts a label cannot carry, like Android's permission-grant ids — and from the label
 * vocabulary only where the backend declares nothing. A single candidate wins outright.
 * Several resolve only when every one of them carries a rank AND all ranks come from the same
 * source: backend ids and label positions are different scales, and an id-rank 2 (a one-time
 * grant) says nothing against a label-position 3 ("Always allow"). A mix of sources cannot be
 * ordered by any table, so it names no single physical button and is refused rather than
 * resolved by tree order or by one side's number happening to be smaller.
 */
export function selectRankedAlertButtonByRole<
  TButton extends Readonly<{ role: AlertButtonRole; label: string }>,
>(
  buttons: readonly TButton[],
  role: 'accept' | 'dismiss',
  backendRank?: (button: TButton) => number | null,
): TButton | null {
  const matching = buttons.filter((button) => button.role === role);
  if (matching.length === 1) return matching[0] ?? null;
  if (matching.length === 0) return null;
  const ranked = matching.map((button) => {
    const fromBackend = backendRank?.(button) ?? null;
    return {
      button,
      rank: fromBackend ?? alertButtonPreferenceRank(button.label, role),
      source: fromBackend !== null ? ('backend' as const) : ('label' as const),
    };
  });
  if (ranked.some((entry) => entry.rank === null)) return null;
  if (ranked.some((entry) => entry.source !== ranked[0]?.source)) return null;
  ranked.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const [first, second] = ranked;
  if (!first || (second && second.rank === first.rank)) return null;
  return first.button;
}

/**
 * The reason a tree-based acting leg (`alert accept|dismiss`) refuses after seeing an alert: the
 * visible buttons name no single choice for the asked-for action. Callers branch on
 * `error.details.reason` instead of the prose; `dispatched: 'no'` states the refusal ran before
 * any press.
 */
export const ALERT_BUTTON_UNDECIDED_REASON = 'alert_button_undecided';

/**
 * The reason a tree-based acting leg refuses before it has a candidate at all: the capture was
 * alert-shaped but unresolvable (degraded buttons, competing sheets, an unverifiable owner).
 * This is not absence — reporting `alert-not-found` over it would state more than the capture
 * supports — and confirming a dismissal must never accept such a capture as proof of absence.
 */
export const ALERT_CAPTURE_UNDECIDED_REASON = 'alert_capture_undecided';

export const ALERT_ACTIONS = ['get', 'accept', 'dismiss', 'wait'] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

export type AlertPlatform = 'android' | 'ios' | 'macos';

export type AlertSource = 'permission' | 'native-dialog' | 'system-dialog';

export type AlertInfo = {
  title?: string;
  message?: string;
  buttons?: string[];
  platform?: AlertPlatform;
  source?: AlertSource;
  packageName?: string;
};
