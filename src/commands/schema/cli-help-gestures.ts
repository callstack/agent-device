import {
  DEFAULT_SCROLL_UNTIL_PASSES,
  SCROLL_UNTIL_MAX_PASSES,
} from '@agent-device/contracts/scroll-command';

export const gestureHelpTopic = {
  summary: 'Full multi-touch gesture shapes and platform quirks',
  body: `agent-device help gestures

Full command shapes and platform quirks for touch/pointer gestures beyond scroll/swipe. Read this when a task needs multi-touch, a repeated gesture series, or exact per-platform verification.

Shapes:
  agent-device longpress 300 500 800
  agent-device longpress @e12 800
  agent-device swipe 320 500 40 500 --count 8 --pause-ms 30 --pattern ping-pong
  agent-device gesture pan 200 420 0 -80 500
  agent-device gesture pan 200 420 80 -40 700 --pointer-count 2
  agent-device scroll down --until 'id=submit'
  agent-device gesture fling right 200 420 180
  agent-device gesture pinch 0.5 200 400
  agent-device gesture rotate 35 200 420
  agent-device gesture transform 200 420 80 -40 2 35 700
  agent-device gesture tap 80 300 200 450 310 600 --count 20 --pause-ms 100
  scroll <dir> --until <selector> repeats scroll-and-check passes until that element is on screen, then stops: one request instead of a scroll-then-snapshot loop, and it stops on the target rather than overshooting it. It reports the passes it spent, fails when the content runs out first, and is refused on top/bottom, which already stop themselves. The default limit is ${DEFAULT_SCROLL_UNTIL_PASSES} gestures. For a longer list, add --max-passes <n> (1–${SCROLL_UNTIL_MAX_PASSES}); it requires --until. Large pass budgets can hit the 90-second request timeout; inspect the current screen and continue with another search if that happens.
  longpress accepts coordinates, @refs, or selectors; prefer @ref/selector, coordinates only as a fallback. Duration and gesture scale/center are positional. gesture pan is one finger by default; add --pointer-count 2 for a parallel two-finger pan. Keep count/pause/pattern on one swipe: --count (cap 200), --pause-ms (cap 10000ms), --pattern ping-pong; the combined swipe/pause schedule is capped at 60000ms.
  For repeated iOS smoke checks: press <x> <y> --count <n> --jitter-px <n> for tap series, swipe <x1> <y1> <x2> <y2> --count <n> for drag series. gesture tap touches 2 to 5 distinct points and holds them for --hold-ms (default 50, min 16); --count repeats the same contacts (cap 200) with --pause-ms between, the series must fit 60000ms counting about 500ms per repetition, and a repetition costs about 450ms on a physical iPhone. Use press for one finger.

Platform quirks:
  Cancelled gesture and swipe requests return COMMAND_FAILED with details.reason=request_canceled and record no action. Repetition pauses are interruptible.
  iOS transform/pinch/rotate use private XCTest synthesis for a continuous two-finger pan/scale/rotation path; verify app metrics instead of assuming requested values map exactly to recognizer output. A gesture tap of three or more fingers can trigger iOS system gestures (undo/redo, the edit menu) and fast repeats can trigger double-tap recognizers, so verify app state; iOS touches the contacts down and lifts them together; Android touches them down up to 8ms apart and lifts them 8ms apart in reverse order.
  Android transform injects a geometric two-finger path; app recognizers may report non-exact pan/scale/rotation -- verify semantic app state or coarse per-component effects instead of exact numeric deltas unless the app exposes stable metrics. If Android needs exact values, prefer isolated gesture pan --pointer-count 2, gesture pinch, or gesture rotate over one combined transform:
    agent-device gesture transform 200 420 80 -40 2 35 700 --platform android
    agent-device wait text "pan changed yes" 3000 --platform android
  tvOS coordinate pan and fling preserve only the dominant direction as a remote swipe; authored endpoints and duration are not preserved.
  Gesture planning prefers the active-app frame; a backend without a gesture viewport resolver falls back to the visible snapshot union, which can be less accurate near edges.
  Rare iOS accessibility gap: a row shown disabled/hittable:false where press reports success but no UI change, or a collapsed composite control with no child refs -- run snapshot -i --json, compute the target center from rects, press x y, then diff snapshot -i. Coordinates are fallback-only; document why you used them.

macOS:
  Context menus are secondary clicks, not long presses: agent-device click @e66 --button secondary --platform macos, then snapshot -i.
  For fast desktop list traversal, prefer fixed pixel wheel steps and batch them when no snapshot is needed between passes:
    agent-device scroll down --pixels 200 --duration-ms 50 --platform macos
    agent-device batch --steps '[{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":50}},{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":50}}]' --platform macos`,
};
