import { SELECTOR_KEY_NAMES } from '@agent-device/selectors';

export const selectorsHelpTopic = {
  summary: 'Selector syntax: keys, quoting, alternatives, and matching rules',
  body: `agent-device help selectors

Selector syntax for commands that take a target. press, click, fill, longpress, hover, get, is, wait, scroll --until, and gesture drag accept a selector wherever they accept an @ref; find accepts one as its query.

Shape:
  One or more key=value terms separated by spaces. An element must match every term. Wrap the whole expression in single quotes so the shell passes it as one argument:
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
  Text values match the whole field, ignoring case and extra whitespace: label="sign in" matches Sign In, not Sign In Now. For a partial match, use find text "Sign" click.
  Boolean keys take true or false, and a bare key means true: visible=false, editable=true, checked.
  On Android, id= matches the full resource-id (pkg:id/name for native XML ids); a React Native testID arrives bare (id="login").
  Matches in distinct subtrees make a mutating command fail with AMBIGUOUS_MATCH and a candidate list. Retry with one candidate ref, or narrow the selector with role, id, or longer text.

Prefer an @ref from the latest snapshot -i, then id/label/role selectors; coordinates are the last resort.`,
} as const;
