export const reactNativeHelpTopic = {
  summary: 'React Native app automation hazards and routing',
  body: `agent-device help react-native

Use this when the target app is React Native, Expo, or a React Native dev client.
This topic covers React Native-specific automation hazards and routes deeper
questions to the owning help topic.

Choose the next help topic:
  Routine QA/dogfood/manual-test flow (open, snapshot -i, press/fill --settle, verify, close): help manual-qa; it has the concrete command shapes, so you should not need generic navigation help for a normal pass.
  Deep exploration of navigation/selector/ref edge cases, or a serial-command question manual-qa does not answer: help workflow (full reference, larger read).
  Logs, network, diagnostics, traces, permission dialogs, or runtime failures: help debugging.
  Component tree, props/state/hooks, slow renders, rerenders, render causes, or dropped frames in React: help react-devtools.
  JS heap growth, heap snapshots, allocation hotspots, or retained-object leaks: help cdp.
  A wrong or stale value that may come from app state or storage (AsyncStorage, MMKV, a feature flag): see Stale state below.
  Remote/cloud config, leases, and local service tunnels: help remote.

React Native dev loop:
  Do not run doctor as routine QA/dogfood prep. Use doctor only when the user asks for setup diagnostics or a command failure points to an unhealthy device, runner, dev-server, or remote environment.
  For "start from screen X" flows, prefer open --relaunch before the first snapshot so the app does not reuse a prior in-progress navigation state.
  JS-only change with Metro or Re.Pack connected:
    agent-device metro reload
    agent-device find "Home"
  Do not use agent-device reload. Use open --relaunch for native startup reset.
  Android RN/Expo/Re.Pack dev server: direct Android localhost URL opens with a port auto-configure host reachability. For app/package launches, run metro prepare when the app cannot reach the local dev server.
  Verify Metro/Re.Pack from the same host context that owns the dev server. If a sandboxed shell cannot curl localhost:8081/status but an unrestricted host shell can, the dev server is running and the sandbox probe is not authoritative.
  adb reverse only affects Android device-to-host traffic. It does not prove host-to-dev-server reachability, and it does not fix a redbox caused by a stale or wrong bundle/app state.
  Multiple local worktrees can reuse one native iOS simulator build by running each worktree's dev server on a different port and opening the same installed app on different simulators with explicit runtime hints:
    agent-device open "React Navigation Example" --platform ios --device "iPhone 17" --session rn-a --metro-host 127.0.0.1 --metro-port 8081 --relaunch
    agent-device open "React Navigation Example" --platform ios --device "iPhone 17 Pro" --session rn-b --metro-host 127.0.0.1 --metro-port 8082 --relaunch
  iOS simulator opens write bare React Native's per-simulator debug server settings before launch. Detected Expo development clients receive their server URL through a launch link instead. Use separate sessions/devices, close both sessions when done, and rebuild only for native changes or dependency changes that affect the binary. One simulator cannot run two copies of the same bundle id.
  Expo Go/dev clients are host shells. Use provided project URLs, verify with snapshot -i after opening, and ask instead of inventing app ids or URLs. Help workflow owns the full Expo URL command shapes.

Overlays and busy RN UIs:
  If snapshot reports a React Native warning/error overlay, handle it before interacting with the app: run agent-device react-native dismiss-overlay. The command sends the safe LogBox/RedBox action and verifies the overlay is gone with a fresh post-dismiss snapshot -i.
  If the command reports the overlay is still visible, use screenshot --overlay-refs for visual evidence and report the overlay instead of pressing warning/error text manually.
  Do not manually press warning/error text bodies, collapsed banner bodies, full-screen warning parents, or broad LogBox/RedBox refs. The dismiss-overlay command owns the narrow LogBox/RedBox targeting policy.
  Report the overlay in the final summary. Use screenshot --overlay-refs before dismissing only if visual evidence is required.
  Minimal overlay continuation:
    agent-device snapshot -i
    agent-device react-native dismiss-overlay
    agent-device snapshot -i
    agent-device press 'id="submit-order"'
  Do not use a plain snapshot after dismiss-overlay when the next step needs current refs; use snapshot -i.
  When overlay evidence is required before continuing, keep the sequence explicit:
    agent-device snapshot -i
    agent-device screenshot --overlay-refs
    agent-device react-native dismiss-overlay
    agent-device snapshot -i
    agent-device press 'id="submit-order"'
  If snapshot times out because the UI never becomes idle, Android accessibility may be blocked by busy or continuously changing app UI. After that timeout, use screenshot as visual truth instead of repeatedly retrying snapshots.
  If iOS snapshot reports AX unavailable or returns only a sparse root, the current screen's accessibility state is invalid. Use plain screenshot as visual truth, coordinate navigation to leave the bad screen, then take a fresh snapshot -i before returning to selector/@ref commands.
    agent-device screenshot
    agent-device press 124 817
    agent-device snapshot -i
  Android runtime permission dialogs and native alerts are handled by alert wait/accept/dismiss. If alert reports no alert but a sheet is visible, alert did not recognize it: use snapshot -i and press @ref on the visible button.

React DevTools routing:
  Keep the agent-device react-devtools prefix on every React DevTools command.
  Use help react-devtools for component trees, props/state/hooks, render profiles, slow renders, rerenders, and their causes.
  If React DevTools cannot attach, report the error and continue with logs, network, perf frames, perf memory, screenshot, and trace evidence instead of blocking the whole flow.

CDP memory routing:
  Keep the agent-device cdp prefix on every CDP command.
  Use help cdp for JS heap usage samples, heap snapshots, snapshot diffs, leak-triplet analysis, allocation hotspots, and retained-object paths.
  Use perf memory sample or perf memory snapshot for native/process memory; use cdp only for JavaScript heap evidence.

Stale state:
  If a wrong or stale value may come from app state or storage, read the value. Do not navigate the UI to infer it.
  JS state through Metro, after cdp target select (help cdp):
    agent-device cdp runtime eval --expr '<expression>' --await
  Stored AsyncStorage on an iOS simulator is under the data container from xcrun simctl get_app_container <udid> <bundle-id> data, in Library/Application Support/<bundle-id>/RCTAsyncLocalStorage_V1. On Android, read databases/RKStorage with adb shell run-as <package>.

Slow-flow investigation:
  Keep one session, open the app first, and snapshot -i before interacting.
  Start React Native slow-flow plans with this ordered scaffold:
    agent-device open "Agent Device Tester" --platform android
    agent-device snapshot -i
  If the task says to open the app, include the open command even when it also describes the current screen.
  Use help react-devtools for the narrow React profile window: react-devtools profile start right before the interaction and react-devtools profile stop after it.
  Use help debugging for logs clear --restart, logs mark, network dump --include headers, perf frames, perf memory, native profiles, traces, and runtime failure evidence.
  For 15-20s async work, use wait with the exact expected text or selector instead of repeated snapshots.
  Report React render offenders separately from network/backend waits and device frame/CPU/memory findings.`,
};
