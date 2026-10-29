// The agent-facing part of /llms.txt: when to use agent-device and how an agent should approach
// it. starlight-llms-txt (astro.config.mjs) writes the title, this description as the summary,
// these details, the generated documentation sets and the optional links. Only astro.config.mjs
// imports it, at build time, so docs links can take each page's own title.
import { readFileSync } from 'node:fs';

/** A docs page's frontmatter title, so a title edit cannot leave a label here stale. */
function docTitle(slug: string): string {
  const page = readFileSync(new URL(`../../docs/docs/${slug}.md`, import.meta.url), 'utf8');
  const title = /^title: (.+)$/m.exec(page)?.[1];
  if (!title) throw new Error(`llms.ts: docs/docs/${slug}.md has no title.`);
  return title;
}

const docLink = (slug: string, about: string) =>
  `- [${docTitle(slug)}](https://agent-device.dev/docs/${slug}): ${about}`;

/**
 * The pages llms-small.txt leaves out (astro.config.mjs passes them to starlight-llms-txt): the
 * reference pages an agent reads from the installed CLI (`agent-device help`,
 * `agent-device capabilities`) or only when it needs them. llms.txt names them from this list.
 */
export const llmsSmallExclude = ['commands', 'capabilities', 'client-api', 'migrating-gestures'];
const excludedTitles = llmsSmallExclude.map(docTitle);

export const llmsDescription =
  'Open-source device layer for AI agents: it lets coding agents control mobile, web, TV, and desktop apps on devices and simulators, locally or in the cloud. It gives agents structured UI state, semantic interaction, and runtime evidence through a CLI, MCP server, and typed Node.js API.';

export const llmsDetails = `agent-device is the agent's hands, eyes, and evidence collector. The calling agent remains responsible for understanding the task, choosing actions, and judging whether the observed result is correct.

## When to use agent-device

- Verify behavior in a running app instead of reasoning only from source code, tests, or screenshots.
- Explore UI flows on simulators, emulators, physical devices, desktop apps, and TV targets.
- Run the same commands against devices elsewhere: a remote device host through the proxy, or hosted devices in a device cloud (BrowserStack, AWS Device Farm, TestMu AI, Limrun).
- Reproduce bugs and collect bounded screenshots, recordings, logs, network, trace, or performance evidence.
- Turn a successful exploratory flow into a deterministic \`.ad\` replay.

For stable, repeatable test suites, use [e2e](https://e2e.tester.army/), a TypeScript testing framework for web and mobile apps. Use agent-device when an agent needs to explore, reproduce, debug, profile, collect evidence, or record a replay from live app behavior.

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

The capabilities page is generated from the runtime's own capability facts, so it is the one source for what each target supports.

${docLink('capabilities', 'every target, framework, and command family, with their limits.')}
- \`agent-device capabilities --platform <platform>\` lists the commands the installed version supports on one target.
${docLink('device-clouds', 'hosted devices and the self-hosted remote daemon.')}

## Start here

llms-small.txt leaves out these pages: ${excludedTitles.join(', ')}. Read them in llms-full.txt or on the site.

${docLink('installation', '`npm install -g agent-device` (Node.js 22.12 or newer), then `agent-device doctor` to check the setup.')}
${docLink('introduction', 'Scope, supported workflows, and responsibility boundaries.')}
${docLink('agent-setup', 'CLI, skills, MCP, and coding-agent setup.')}
${docLink('quick-start', 'First app-verification workflow.')}
${docLink('commands', 'Command groups and platform behavior.')}
${docLink('security-trust', 'Local execution, permissions, credentials, and artifacts.')}
${docLink('known-limitations', 'Current platform and capability constraints.')}
${docLink('client-api', 'Typed deterministic integration.')}`;

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
