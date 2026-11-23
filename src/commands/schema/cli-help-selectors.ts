import { SELECTOR_KEY_NAMES } from '@agent-device/selectors';

export const selectorsHelpTopic = {
  summary: 'Selector syntax: keys, quoting, alternatives, and matching rules',
  body: `agent-device help selectors

Selector syntax for commands that take a target. press, click, fill, longpress, hover, get, is, and wait take a selector as the target, gesture drag as its source and destination, and gesture pinch as the element to pinch. find takes one as its query, and scroll --until and screenshot --crop-on as the flag value.

Shape:
  One or more terms separated by spaces. An element must match every term. A term is key=value, or a boolean key alone, which means key=true: role=switch checked is role=switch checked=true. Wrap the whole expression in single quotes so the shell passes it as one argument:
    agent-device press 'role=button label="Continue"'
    agent-device fill 'label="Email" editable=true' "qa@example.com"
    agent-device wait 'id="checkout-total"' 5000
    agent-device press 'id="submit" || label="Submit order"'
  Keys: ${SELECTOR_KEY_NAMES.join(' ')}. Keys are case-insensitive.
  A role word is not a key: write role=button label="Save", not button="Save". No CSS selectors, --selector, or --text.
  Quote values with spaces: label="Sign in". Escape a quote inside a value with a backslash: label="Say \\"hi\\"".
  || separates alternatives. They are tried left to right, and the first that resolves is used.

Matching:
  id is the identifier (test ID, resource ID, accessibility identifier); label and value are the accessibility label and value; text is the first non-empty of label, value, and identifier; role is the role in brackets in snapshot output (button, text-field, switch).
  appname and windowtitle are the owning app's name and window title. Linux snapshots and the macOS desktop, frontmost-app, and menubar surfaces report them; a macOS app session reports them only with AGENT_DEVICE_MACOS_APP_BACKEND=native. Elsewhere a non-empty value matches nothing.
  Text values match the whole field, ignoring case and extra whitespace: label="sign in" matches Sign In, not Sign In Now. For a partial match, use find text "Sign" click.
  Boolean keys take true or false: visible=false, editable=true. visible, hidden, editable, selected, focused, enabled, and hittable test the element state of that name.
  checked tests a switch, checkbox, or radio. checked=true matches only an explicitly checked control and checked=false only an explicitly unchecked one; an iOS mixed state and an element with no checked state match neither.
  On Android, id= matches the full resource-id (pkg:id/name for native XML ids); a React Native testID arrives bare (id="login").
  Matches in distinct subtrees make a mutating command fail with AMBIGUOUS_MATCH and a candidate list. Retry with one candidate ref, or narrow the selector with role, id, or longer text.

Prefer an @ref from the latest snapshot -i, then id/label/role selectors; coordinates are the last resort.`,
} as const;
