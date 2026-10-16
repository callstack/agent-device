export const ALERT_POLL_INTERVAL_MS = 300;
export const DEFAULT_ALERT_TIMEOUT_MS = 10_000;
export const ALERT_ACTION_RETRY_MS = 2_000;

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
 * The one button label vocabulary every tree-based alert backend classifies with. English-only,
 * matching the untranslated device locale the alert lanes are validated against; a localized
 * button classifies `neutral`, so acting legs refuse on the button-undecided reason rather than
 * guessing at a translation.
 */
const ACCEPT_LABEL_PATTERN =
  /^(?:ok|allow|allow all|allow once|allow all the time|allow while using (?:the )?app|allow notifications|always allow|yes|continue|save|confirm|turn on|open settings|while using the app|only this time)$/i;
// `don.?t allow` covers the straight, missing, and typographic apostrophe in one alternate.
const DISMISS_LABEL_PATTERN =
  /^(?:cancel|deny|don.?t allow|not now|no|dismiss|close|close app|later|skip|ask app not to track)$/i;

/** One button's action role under the shared vocabulary; anything unnamed is neutral. */
export function classifyAlertButtonRole(label: string): AlertButtonRole {
  const trimmed = label.trim();
  if (ACCEPT_LABEL_PATTERN.test(trimmed)) return 'accept';
  if (DISMISS_LABEL_PATTERN.test(trimmed)) return 'dismiss';
  return 'neutral';
}

/**
 * The one choice boundary for a shared choice: a role exactly one visible button carries, or
 * null when none does and when two or more do — pressing one of a duplicated choice would pick
 * a side the capture does not name, so duplicates refuse rather than resolve by tree order.
 */
export function selectUniqueAlertButtonByRole<TButton extends Readonly<{ role: AlertButtonRole }>>(
  buttons: readonly TButton[],
  role: 'accept' | 'dismiss',
): TButton | null {
  const matching = buttons.filter((button) => button.role === role);
  return matching.length === 1 ? (matching[0] ?? null) : null;
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
