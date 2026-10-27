// The agent-facing part of /llms.txt: when to use agent-device and how an agent should approach
// it. starlight-llms-txt (astro.config.mjs) writes the title, this description as the summary,
// these details, the generated documentation sets and the optional links.

export const llmsDescription =
  'Open-source, agent-native automation and verification for mobile, TV, desktop, and managed web apps. It gives AI agents structured UI state, semantic interaction, and runtime evidence through a CLI, MCP server, and typed Node.js API.';

export const llmsDetails = `agent-device is the agent's hands, eyes, and evidence collector. The calling agent remains responsible for understanding the task, choosing actions, and judging whether the observed result is correct.

## When to use agent-device

- Verify behavior in a running app instead of reasoning only from source code, tests, or screenshots.
- Explore UI flows on simulators, emulators, physical devices, desktop apps, TV targets, and supported hosted devices.
- Reproduce bugs and collect bounded screenshots, recordings, logs, network, trace, or performance evidence.
- Turn a successful exploratory flow into a deterministic \`.ad\` replay.

Use established test frameworks such as Appium, Maestro, Detox, XCTest, and Espresso for stable human-authored suites. Use agent-device when an agent needs to explore, observe, debug, or verify live behavior.

## How agents should approach it

- Finding this page does not authorize installing software or controlling a device. Use agent-device only when the user's task calls for app or device automation.
- Prefer an existing trusted installation or project-pinned version. Do not autonomously download and execute a mutable \`latest\` package.
- For a normal app-driving task, start with \`agent-device open <app> --foreground\` and continue from the returned interactive snapshot.
- Follow the basic loop: open, inspect, act, verify the named outcome, and close.
- Copy current element refs exactly. Prefer refs and semantic selectors over coordinates; use screenshots as evidence or when accessibility data is unavailable.
- Keep state-changing operations serial within one session. Use separate sessions and devices for parallel work.
- Follow command error hints. For exact syntax and platform behavior, use the installed \`agent-device help <command|topic>\` because it matches the installed version.
- agent-device runs locally by default. Remote devices and cloud providers are used only when explicitly configured. Captures and diagnostics may contain sensitive app data.

## Capabilities

- Targets: iOS and Android simulators, emulators, and physical devices; HarmonyOS; tvOS; Android TV; Fire TV devices running Fire OS; macOS desktop and app devices; Linux desktop targets; and a limited managed web browser.
- Vega OS is supported only in the Vega Virtual Device: app open and close plus remote keys. Physical Vega OS devices, capture, selectors, install, logging, and performance report unsupported there.
- Frameworks: native apps, React Native, Expo, and Flutter. Which commands and evidence you get depends on what each target supports.
- Reads app state through accessibility snapshots with element refs and semantic selectors; use screenshots as evidence or when accessibility data is poor.
- Collects app and device logs and symbolicates crashes on Apple targets. Android Java/R8 and native crash symbolication is left to other tools.
- Network inspection parses recent HTTP(s) entries from app logs locally, so results depend on what the app logs. On TestMu AI, network logs are a provider feature returned after the session ends.
- Performance: CPU profile reports return weighted top functions and frame health covers dropped frames and jank windows. Raw xctrace and Perfetto traces are kept on disk as artifacts for the agent to inspect.
- React DevTools inspects React Native components and profiles renders. JS heap usage, heap snapshots, and small runtime evals run through Metro CDP.
- Replay: save a working flow as a \`.ad\` script and run it with the \`test\` runner. Import Maestro YAML flows and export \`.ad\` scripts to strict Maestro YAML.
- Integration: a stdio MCP server and a typed Node.js client API over the same execution path as the CLI.
- Runs parallel agent sessions against separate sessions and devices, with host-local device claims and tenant-scoped leases on remote daemons. Keep state-changing commands serial within one session.
- Device clouds: Limrun, BrowserStack, AWS Device Farm, and TestMu AI, plus a self-hosted remote daemon you run yourself.
- Open source under the MIT license.
- [Capabilities](https://agent-device.dev/docs/capabilities): full per-target capability list and limits.

## Start here

- [Introduction](https://agent-device.dev/docs/introduction): Scope, supported workflows, and responsibility boundaries.
- [AI Agent Setup](https://agent-device.dev/docs/agent-setup): CLI, skills, MCP, and coding-agent setup.
- [Quick Start](https://agent-device.dev/docs/quick-start): First app-verification workflow.
- [Commands](https://agent-device.dev/docs/commands): Command groups and platform behavior.
- [Security and Trust](https://agent-device.dev/docs/security-trust): Local execution, permissions, credentials, and artifacts.
- [Known Limitations](https://agent-device.dev/docs/known-limitations): Current platform and capability constraints.
- [Node.js API](https://agent-device.dev/docs/client-api): Typed deterministic integration.`;

export const llmsOptionalLinks = [
  {
    label: 'GitHub',
    url: 'https://github.com/callstack/agent-device',
    description: 'Source, releases, issues, and official skills.',
  },
  {
    label: 'npm',
    url: 'https://www.npmjs.com/package/agent-device',
    description: 'Official package distribution.',
  },
  {
    label: 'MCP discovery manifest',
    url: 'https://agent-device.dev/.well-known/mcp.json',
    description:
      'Machine-readable stdio MCP server metadata (registry identity, npm package, current version). agent-device has no HTTP MCP endpoint; the stdio server is started with `agent-device mcp`.',
  },
];
