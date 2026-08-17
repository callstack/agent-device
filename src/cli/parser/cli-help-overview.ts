import { SELECTOR_KEY_NAMES } from '@agent-device/selectors';
import { listCliCommandNames } from '../../command-catalog.ts';

/**
 * The root help is the no-skill agent's decision card, not the command reference.
 * Keep situational detail in `help workflow` and the derived catalog in `help commands`.
 */
export function renderCliHelpOverview(): string {
  return `agent-device <command> [args] [--json]

Automates iOS, Android, macOS, TV, and web apps for AI agents.
All ${listCliCommandNames().length} commands: agent-device help commands

Start:
  When starting a task with a known app, first run:
    agent-device open <app> --foreground
  It starts the session and returns the initial interactive snapshot with @refs.
  Do not probe first with devices, apps, appstate, snapshot, or screenshot.
  Unknown app id: devices, then apps, then open <discovered-id>. Never invent ids.
  Resuming an existing session: continue from its current state; do not reopen it.

Loop:
  press|click|fill|longpress <target> ... --settle
  hover <target> --settle (web only; reveals hover-gated UI)
  scroll <direction|top|bottom> [amount] --settle; back --settle
    acts, waits for quiet, and prints the UI diff. Continue from that diff.
    Run snapshot -i only when the diff lacks the next target or did not settle.
  Verify a named expectation with the diff, wait text "...", wait <selector>,
    is, get, or find. A bare screenshot is not verification.
  End with: agent-device close

Targets:
  Copy refs exactly: @e12, @e12~s4. Keep @ and any ~sN pin; refs go stale
    after mutations. A literal @handle is label="@handle", not a bare ref.
  Prefer refs, then id/label/role selectors. Selector keys: ${SELECTOR_KEY_NAMES.join(' ')}.
  Coordinates are last resort: after snapshot -i shows no semantic target, or a
    sparse/AX-unavailable warning says its refs and selectors are invalid.
    Then screenshot, press <x> <y>, and re-snapshot on the changed screen.

Rules:
  --settle is only for press/click/fill/longpress/hover/scroll/back; never open,
    snapshot, or close. type never accepts --settle.
  fill <target> <text> --settle replaces; type <text> appends after focus.
  Late network/debounce result: wait text "Expected", not snapshot polling.
  Output full agent-device commands; no pipes, grep, jq, or pseudo-commands.
  Stop when the requested end state is visible. Mutations run serially.

More commands (exact shapes: agent-device help <command>):
  open install devices apps boot close       app and device lifecycle
  screenshot record logs network perf trace  evidence and diagnostics
  replay test batch session                   scripted flows
  alert keyboard clipboard settings gesture  system and input

Guides (agent-device help <topic>):
  workflow    full refs, selectors, waits, recovery, and platform limits
  manual-qa / dogfood / validate / debugging / scripting / gestures
  react-native / react-devtools / cdp / tv / web / macos / remote
  physical-device / ios-system-ui / maestro
`;
}
