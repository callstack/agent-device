// The facts every page uses, in one place: the landing pages, the docs chrome, astro.config.mjs,
// robots.txt, the structured data and the social card (scripts/og.mjs) all read this file.
// Every command, package and claim comes from the repo, its docs or a public source linked
// here: no invented numbers, adopters, logos or testimonials.
//
// Copy rules (see the design guide): headlines run two beats, the second shown in the accent;
// ledes are one or two sentences; plain words, no "just" or "simply", no marketing adjectives.

import type { IconName } from '../components/site/icons';

export const site = {
  name: 'agent-device',
  /** The text in the accent wordmark block, the window tags and the giant closing wordmark. */
  wordmark: 'agent-device',
  /** The site origin, no trailing slash. Canonicals, the sitemap and robots.txt use it. */
  url: 'https://agent-device.dev',
  repo: 'https://github.com/callstack/agent-device',
  /**
   * What it is, in a few words. The home page title is "Name: subtitle" (src/site/meta.ts),
   * 60 characters at most in all.
   */
  subtitle: 'Eyes and hands for coding agents on real apps',
  /** The motto, in two beats. Used by the hero, the social card and the banner. */
  headline: ['Give your agent eyes and hands.', 'On the real app.'],
  /** The hero lede: one or two sentences, naming who it is for. */
  lede: 'agent-device lets coding agents run, read and operate real iOS, Android, TV and desktop apps. Ask for a change, and your agent builds it, checks it on the device and brings back evidence you can review.',
  /** The meta description: 160 characters at most. */
  description:
    'Open-source runtime that lets AI coding agents run, read, operate and verify real iOS, Android, TV and desktop apps, and bring back evidence.',
  install: 'npm i -g agent-device',
  /** The agent skill install, in the short owner/repo form. */
  skill: 'npx skills add callstack/agent-device' as string | undefined,
  /** Alt text for the social card (public/og-image.jpg): the lockup, the motto, the picture. */
  ogAlt: 'agent-device by Callstack. Give your agent eyes and hands. On the real app.',
  /** Who holds the copyright in the footer: "© YEAR AGENT-DEVICE BY CALLSTACK". */
  owner: 'Callstack',
  callstack: 'https://callstack.com/?utm_source=agent-device&utm_medium=referral',
  license: {
    name: 'MIT',
    url: 'https://github.com/callstack/agent-device/blob/main/LICENSE',
    /** For the structured data. */
    spdx: 'https://opensource.org/licenses/MIT',
  },
  npm: 'https://www.npmjs.com/package/agent-device',
  discord: 'https://discord.gg/eYapw6F3',
  /** Platforms or targets, in the order the brief fixes. */
  platforms: [
    'iOS',
    'Android',
    'HarmonyOS',
    'tvOS',
    'Android TV',
    'Fire TV',
    'Vega OS',
    'macOS',
    'Linux',
    'Web',
  ],
  /** The main language of the source, for the structured data. */
  language: 'TypeScript',
  /** No pixel mark: the lockup is the wordmark alone. */
  mark: undefined as string[] | undefined,
};

/** Docs paths the pages link to. */
export const docs = {
  intro: '/docs/introduction',
  start: '/docs/quick-start',
  install: '/docs/installation',
  agents: '/docs/agent-setup',
  snapshots: '/docs/snapshots',
  replay: '/docs/replay-e2e',
  debugging: '/docs/debugging-profiling',
  clouds: '/docs/device-clouds',
  proxy: '/docs/remote-proxy',
  client: '/docs/client-api',
  aiSdk: '/docs/ai-sdk',
  eve: '/docs/eve',
  sessions: '/docs/sessions',
  capabilities: '/docs/capabilities',
  security: '/docs/security-trust',
  llms: '/llms.txt',
};

type Link = { text: string; href: string };

/**
 * The nav links, mono and centred. The docs header shows the ones that leave the docs (any
 * link not under /docs).
 */
export const nav: Link[] = [
  { text: 'Docs', href: docs.intro },
  { text: 'Showcase', href: '/showcase' },
  { text: 'Cloud', href: '/cloud' },
  { text: 'Templates', href: '/templates' },
  { text: 'GitHub', href: site.repo },
];

/** The footer row, right of the copyright, on every page and in the docs. */
export const footer: Link[] = [
  { text: 'Docs', href: docs.intro },
  { text: 'llms.txt', href: docs.llms },
  { text: 'Contact', href: '/contact' },
  { text: 'Discord', href: site.discord },
  { text: 'GitHub', href: site.repo },
  { text: `${site.license.name} license`, href: site.license.url },
  { text: 'Callstack', href: site.callstack },
];

/** Paths kept out of the sitemap. Pages rendered with `noindex` belong here too. */
export const noindexPaths = ['/404'];

/** The marquee under the hero: targets, then the app frameworks it drives. */
export const marquee = [...site.platforms, 'React Native', 'Expo', 'Flutter'];

/** The 404 line, in two beats. */
export const notFound = ['This screen never rendered.', `The rest of ${site.name} did.`];

/** Questions people ask, answered from the README FAQ. Inline `code` is allowed. */
export const faq = [
  {
    q: 'Is there an MCP server?',
    a: 'Yes. `agent-device mcp` starts the official stdio MCP server. It is one entry point to the same runtime as the CLI and the typed Node.js API, so sessions, evidence and replay behave the same in all three.',
  },
  {
    q: 'Does it work with React Native, Expo, Flutter and native apps?',
    a: 'Yes. It drives native iOS and Android apps and React Native, Expo and Flutter apps on supported targets. The commands and evidence vary by target; `agent-device capabilities --platform <platform>` lists them.',
  },
  {
    q: 'How is it different from Appium, Detox or Maestro?',
    a: 'With agent-device an agent reads the app and chooses each command at run time. Appium, Detox and Maestro run suites people write and maintain. agent-device complements them: save a run as an `.ad` script or export it as strict Maestro YAML.',
  },
  {
    q: 'Can it run in CI?',
    a: 'Yes. Record a run as an `.ad` script, replay it in CI with `agent-device test`, and keep the screenshots and logs as artifacts. The EAS Workflows template is a working example.',
  },
  {
    q: 'Can I build my own agent or QA product on it?',
    a: 'Yes. The typed Node.js client is a public surface over the same runtime, with AI SDK tools and an Eve integration on top. TesterArmy e2e and T3 Code build on it.',
  },
  {
    q: 'Can several agents share one machine?',
    a: 'Yes. Sessions are scoped to the git worktree, and device claims stop parallel agents from taking over each other’s simulators and emulators. `agent-device device status` shows who holds what.',
  },
];

/** One line of a terminal transcript: a command, its output, a comment, or a result. */
export type Line = { kind: 'cmd' | 'out' | 'add' | 'del' | 'dim' | 'ok'; text: string };

/**
 * The hero: a prompt for each kind of job, and the agent-device commands the agent runs for it.
 * Prompts come from the README; commands and the output lines come from the README and the docs
 * (the Contacts walkthrough, Debugging and profiling). Refs vary between runs.
 */
export const jobs = [
  {
    id: 'build',
    name: 'Build',
    prompt:
      'Implement the onboarding screen, run it on the iOS simulator and Android emulator, and attach screenshots.',
    transcript: [
      { kind: 'cmd', text: 'agent-device open MyApp --platform ios' },
      { kind: 'cmd', text: 'agent-device snapshot -i' },
      { kind: 'cmd', text: 'agent-device screenshot ./onboarding-ios.png' },
      { kind: 'cmd', text: 'agent-device open MyApp --platform android' },
      { kind: 'cmd', text: 'agent-device snapshot -i' },
      { kind: 'cmd', text: 'agent-device screenshot ./onboarding-android.png' },
      { kind: 'cmd', text: 'agent-device close' },
    ] as Line[],
  },
  {
    id: 'verify',
    name: 'Verify',
    prompt:
      'Add a contact named Ada in the iOS Contacts app, verify it saved, and attach evidence.',
    transcript: [
      { kind: 'cmd', text: 'agent-device open Contacts --platform ios --save-script' },
      { kind: 'cmd', text: 'agent-device snapshot -i' },
      { kind: 'out', text: '@e2 [button] "Add"' },
      { kind: 'cmd', text: 'agent-device record start' },
      { kind: 'cmd', text: 'agent-device press @e2 --settle' },
      { kind: 'add', text: '+ @e7 [text-field] "First name"' },
      { kind: 'cmd', text: 'agent-device fill @e7 "Ada" --settle' },
      { kind: 'add', text: '+ @e14 [text-field] "Ada"' },
      { kind: 'cmd', text: 'agent-device screenshot ./contact-form.png' },
      { kind: 'cmd', text: 'agent-device record stop' },
      { kind: 'cmd', text: 'agent-device close' },
    ] as Line[],
  },
  {
    id: 'profile',
    name: 'Profile',
    prompt: 'Check whether this change causes unnecessary React Native re-renders.',
    transcript: [
      { kind: 'cmd', text: 'agent-device open MyApp --platform ios' },
      { kind: 'cmd', text: 'agent-device react-devtools profile start' },
      { kind: 'cmd', text: 'agent-device fill \'id="catalog-search"\' "tart" --delay-ms 100' },
      { kind: 'cmd', text: 'agent-device react-devtools profile stop' },
      {
        kind: 'out',
        text: 'React profile 8.3s: 8 commits, 1303ms rendering, 8 over 16ms (worst #6 188ms)',
      },
      { kind: 'add', text: '1. memo-defeated ContactRow: memo bypassed on 480/480 updates' },
      { kind: 'cmd', text: 'agent-device react-devtools profile report ContactRow' },
    ] as Line[],
  },
];

/**
 * Who uses agent-device. Every entry is backed by a public source, checked on 2026-10-27:
 * code in the adopter's own public repo, or a post they or Callstack published. Featured
 * adopters show their official mark (`logo`) on the home page. Do not add entries without a
 * source (the README lists some that have none).
 */
export type Adopter = {
  name: string;
  /** The project, when it isn't the company's main product. */
  project?: string;
  how: string;
  sources: Link[];
  /** Shown in the home page strip. */
  featured?: boolean;
  /**
   * The official mark, in docs/public/logos. `mono` draws it as a white silhouette; `keep`
   * keeps its own light and dark parts (a mark on a solid tile), in greyscale.
   */
  logo?: { src: string; mode: 'mono' | 'keep' };
};

export const adopters: Adopter[] = [
  {
    name: 'Expensify',
    logo: { src: '/logos/expensify.svg', mode: 'mono' },
    how: 'An agent skill reproduces each bug, records before and after video, replays an `.ad` script, measures Sentry spans and profiles React renders, as evidence on the pull request.',
    sources: [
      {
        text: 'agent-device-evidence skill',
        href: 'https://github.com/Expensify/App/blob/main/.claude/skills/agent-device-evidence/SKILL.md',
      },
      {
        text: 'Case study',
        href: 'https://www.callstack.com/blog/how-expensify-uses-agent-device-for-mobile-bug-evidence-and-profiling',
      },
    ],
    featured: true,
  },
  {
    name: 'Shopify',
    logo: { src: '/logos/shopify.svg', mode: 'mono' },
    project: 'FlashList',
    how: 'An agent-device skill, wired into the repo’s agent instructions and its fix-a-GitHub-issue workflow.',
    sources: [
      {
        text: 'Skill',
        href: 'https://github.com/Shopify/flash-list/blob/main/.claude/skills/agent-device/SKILL.md',
      },
    ],
    featured: true,
  },
  {
    name: 'MetaMask',
    logo: { src: '/logos/metamask.svg', mode: 'mono' },
    project: 'MetaMask Mobile',
    how: 'A dependency of the mobile app, with a setup guide and an Android snapshot backend for its LLM workflows.',
    sources: [
      {
        text: 'Setup guide',
        href: 'https://github.com/MetaMask/metamask-mobile/blob/main/docs/readme/agent-device.md',
      },
    ],
    featured: true,
  },
  {
    name: 'Uniswap',
    logo: { src: '/logos/uniswap.svg', mode: 'mono' },
    project: 'Uniswap mobile',
    how: 'Connects the mobile app to AWS Device Farm devices through agent-device.',
    sources: [
      {
        text: 'deviceFarmConnect.ts',
        href: 'https://github.com/Uniswap/interface/blob/main/apps/mobile/scripts/deviceFarmConnect.ts',
      },
    ],
    featured: true,
  },
  {
    name: 'Expo',
    logo: { src: '/logos/expo.svg', mode: 'mono' },
    project: 'Orbit',
    how: 'Agents verify Orbit on physical iPhones, iPads and Android devices with agent-device, per the repo’s agent instructions.',
    sources: [
      { text: 'CLAUDE.md', href: 'https://github.com/expo/orbit/blob/main/CLAUDE.md' },
      {
        text: 'EAS Workflows QA agent on expo.dev',
        href: 'https://expo.dev/blog/build-an-ai-qa-agent-for-expo-apps-with-eas-workflows-in-minutes-today',
      },
    ],
    featured: true,
  },
  {
    name: 'T3 Code',
    logo: { src: '/logos/t3-code.svg', mode: 'keep' },
    how: 'Simulator and emulator support in T3 Code is built on agent-device.',
    sources: [
      { text: 'Pull request #10677', href: 'https://github.com/pingdotgg/t3code/pull/10677' },
    ],
    featured: true,
  },
  {
    name: 'TesterArmy',
    logo: { src: '/logos/testerarmy.png', mode: 'mono' },
    project: 'e2e',
    how: 'The mobile engine of the e2e testing agent, `@e2e-dev/mobile`, runs on agent-device.',
    sources: [
      {
        text: 'packages/mobile',
        href: 'https://github.com/tester-army/e2e/blob/main/packages/mobile/package.json',
      },
      { text: 'e2e.tester.army', href: 'https://e2e.tester.army' },
    ],
    featured: true,
  },
  {
    name: 'React Navigation',
    how: 'A repo script drives the example app with agent-device for contributors and their agents.',
    sources: [
      {
        text: 'scripts/agent-device.ts',
        href: 'https://github.com/react-navigation/react-navigation/blob/main/scripts/agent-device.ts',
      },
    ],
  },
  {
    name: 'Storybook',
    project: 'Storybook for React Native',
    how: 'End-to-end checks of the addons across Expo, Expo Router and Re.Pack examples.',
    sources: [
      {
        text: 'e2e/agent-device',
        href: 'https://github.com/storybookjs/react-native/tree/HEAD/e2e/agent-device',
      },
    ],
  },
  {
    name: 'Rocket.Chat',
    project: 'Rocket.Chat React Native',
    how: 'End-to-end tests run on e2e, whose mobile engine drives simulators and emulators through agent-device.',
    sources: [
      {
        text: 'e2e/README.md',
        href: 'https://github.com/RocketChat/Rocket.Chat.ReactNative/blob/develop/e2e/README.md',
      },
    ],
  },
  {
    name: 'OneKey',
    how: 'A UI verification skill with agent-device rules for React Native, and regression scenarios.',
    sources: [
      {
        text: '1k-ui-verify skill',
        href: 'https://github.com/OneKeyHQ/app-monorepo/blob/x/.skillshare/skills/1k-ui-verify/SKILL.md',
      },
    ],
  },
  {
    name: 'Margelo',
    project: 'react-native-quick-crypto',
    how: 'The example app’s end-to-end runner drives the app with agent-device.',
    sources: [
      {
        text: 'e2e runner',
        href: 'https://github.com/margelo/react-native-quick-crypto/blob/main/example/test/e2e/runner.mjs',
      },
    ],
  },
  {
    name: 'App & Flow',
    project: 'stim',
    how: 'An agent driver package for stim built on agent-device.',
    sources: [
      {
        text: 'agent-driver-agent-device',
        href: 'https://github.com/appandflow/stim/blob/main/packages/agent-driver-agent-device/package.json',
      },
    ],
  },
  {
    name: 'Legend',
    project: 'Legend List',
    how: 'agent-device is the agent runtime for the Legend apps.',
    sources: [
      {
        text: 'docs/agent-runtime.md',
        href: 'https://github.com/LegendApp/legend-apps/blob/main/docs/agent-runtime.md',
      },
    ],
  },
  {
    name: 'Akveo',
    project: 'UI Kitten',
    how: 'agent-device is a dev dependency, with agent instructions for driving the showcase app.',
    sources: [
      {
        text: 'AGENTS.md',
        href: 'https://github.com/akveo/react-native-ui-kitten/blob/master/AGENTS.md',
      },
    ],
  },
  {
    name: 'Kortix',
    project: 'Suna',
    how: 'The repo’s end-to-end skill uses agent-device for mobile setup and debugging.',
    sources: [
      {
        text: 'e2e skill',
        href: 'https://github.com/kortix-ai/suna/blob/main/.agents/skills/e2e/SKILL.md',
      },
    ],
  },
];

/** Examples that exist today, each linking to its code. The /templates page lists them. */
export const templates = [
  {
    icon: 'flag',
    title: 'QA agent on EAS Workflows',
    body: 'An Expo EAS workflow that builds the app, runs an AI SDK agent on agent-device against it and keeps the evidence as artifacts.',
    tags: ['CI', 'Expo', 'AI SDK'],
    href: 'https://github.com/callstackincubator/eas-agent-device',
    cta: 'Open the template',
  },
  {
    icon: 'code',
    title: 'AI SDK tools',
    body: 'Give an AI SDK agent the agent-device commands as typed tools with `createAgentDeviceTools`.',
    tags: ['Node.js', 'AI SDK'],
    href: 'https://github.com/callstack/agent-device/blob/main/examples/sdk/ai-sdk-tools.ts',
    cta: 'Read the example',
  },
  {
    icon: 'stack',
    title: 'Batch orchestration',
    body: 'Run batches through your own transport with `runBatch`, keeping step validation, partial results and errors aligned with the CLI’s `batch` command.',
    tags: ['Node.js'],
    href: 'https://github.com/callstack/agent-device/blob/main/examples/sdk/batch-orchestration.ts',
    cta: 'Read the example',
  },
  {
    icon: 'panel',
    title: 'Client session',
    body: 'Open an app, read a snapshot and press an element with the typed client, then close the session.',
    tags: ['Node.js'],
    href: 'https://github.com/callstack/agent-device/blob/main/examples/sdk/client-session.ts',
    cta: 'Read the example',
  },
  {
    icon: 'network',
    title: 'Metro runtime',
    body: 'Resolve the host, port and scheme a client connects to Metro through, for React Native integrations of your own.',
    tags: ['Node.js', 'React Native'],
    href: 'https://github.com/callstack/agent-device/blob/main/examples/sdk/metro-runtime.ts',
    cta: 'Read the example',
  },
  {
    icon: 'test',
    title: 'Replay scripts',
    body: 'The `.ad` replay scripts the project runs against its own test app, as a reference for writing yours.',
    tags: ['Replay', 'CI'],
    href: 'https://github.com/callstack/agent-device/tree/main/examples/test-app/replays',
    cta: 'Browse the scripts',
  },
] as { icon: IconName; title: string; body: string; tags: string[]; href: string; cta: string }[];

/** The /cloud page: the same commands from a laptop to CI to remote devices. */
export const cloud = {
  headline: ['Same commands.', 'Any device, anywhere.'],
  lede: 'Your agent keeps the same agent-device workflow when it leaves your laptop: replay in CI, run from Linux against a Mac that hosts the simulators, or drive hosted devices in a device cloud.',
  paths: [
    {
      icon: 'panel',
      label: 'Local',
      title: 'On your machine',
      body: 'Simulators, emulators and physical devices on your Mac or Linux box. Sessions follow your git worktree, so parallel agents don’t take over each other’s devices.',
      cmd: 'agent-device open MyApp --platform ios',
      href: docs.sessions,
    },
    {
      icon: 'flag',
      label: 'CI',
      title: 'On every pull request',
      body: 'Replay saved `.ad` scripts with `agent-device test`, keep screenshots and logs as artifacts, and report to JUnit.',
      cmd: 'agent-device test ./workflows',
      href: docs.replay,
    },
    {
      icon: 'network',
      label: 'Remote',
      title: 'On a device host',
      body: 'Run the agent on Linux or in a cloud workspace and execute on the Mac or Linux host that has the devices, through the remote proxy.',
      cmd: 'agent-device proxy --port 4310',
      href: docs.proxy,
    },
    {
      icon: 'cube',
      label: 'Device clouds',
      title: 'On hosted devices',
      body: 'The same commands drive BrowserStack, AWS Device Farm, TestMu AI and Limrun devices through provider plugins.',
      cmd: 'agent-device connect limrun --platform ios',
      href: docs.clouds,
    },
  ] as { icon: IconName; label: string; title: string; body: string; cmd: string; href: string }[],
  providers: [
    { name: 'BrowserStack', href: '/docs/browserstack' },
    { name: 'AWS Device Farm', href: '/docs/aws-device-farm' },
    { name: 'TestMu AI', href: '/docs/testmu' },
    { name: 'Limrun', href: '/docs/limrun' },
  ],
  team: {
    headline: ['Need devices for your team?', 'Talk to Callstack.'],
    body: 'We help teams connect agent-device to their CI and pull request reviews, set up shared iOS and Android device hosts, and run agent-driven QA.',
  },
};

/** The home page, section by section, in page order. index.astro only lays these out. */
export const home = {
  /** The `zsh` window beside the hero copy (hidden below 64rem): setup in a few lines. */
  setup: [
    { cmd: site.install },
    { comment: 'for you: the CLI and the MCP server' },
    ...(site.skill ? [{ cmd: site.skill }, { comment: 'for your agent: the skill' }] : []),
  ] as ({ cmd: string } | { comment: string })[],

  /** The strip under the hero: who uses it, by name, linking to /showcase. */
  usedBy: {
    label: 'Used by teams at',
    names: adopters.filter((a) => a.featured).map((a) => a.name),
    more: { text: 'See how they use it', href: '/showcase' },
  },

  /** The bottleneck: why verification is the step that slows shipping with agents. */
  bottleneck: {
    label: 'Why agent-device',
    headline: ['Agents write the code now.', 'Verification is what slows shipping.'],
    body: [
      'Coding agents turn out changes faster than anyone can check them on a phone. A mobile change only proves itself on a simulator or a device, and that is the one place agents could not go.',
      'So the checking falls back on people: review rounds to ask whether it was run, QA passes on test builds, regressions found by users. agent-device moves that check to the agent, with evidence attached.',
    ],
  },

  /** The delivery loop, and the step agent-device owns. */
  loop: {
    label: 'The loop',
    headline: ['Where agent-device fits', 'in shipping with agents.'],
    lede: 'The same loop runs on every change. agent-device is the step where the agent checks its work on the real app, and leaves proof for the people who ship it.',
    /** Grid order: the top row runs left to right, the bottom row back right to left. */
    steps: [
      { n: 1, title: 'Task', body: 'You, or an issue, describe the change.' },
      { n: 2, title: 'Code', body: 'The agent writes and reviews the change.' },
      {
        n: 3,
        title: 'Verify',
        body: 'The agent runs the app, checks the change on the device and records what it saw.',
        product: true,
      },
      {
        n: 6,
        title: 'Feedback',
        body: 'Crashes, bugs and slow screens come back as the next task, with a repro.',
        product: true,
      },
      {
        n: 5,
        title: 'Review and ship',
        body: 'People review proof instead of a description, and merge.',
      },
      {
        n: 4,
        title: 'Evidence',
        body: 'Screenshots, video, logs and a replay script land on the pull request.',
        product: true,
      },
    ] as { n: number; title: string; body: string; product?: boolean }[],
  },

  /** Three stages of the loop, each with a picture and a proof point. */
  inner: {
    label: 'While the agent builds',
    headline: ['It checks its own work.', 'Before you see it.'],
    lede: 'Ask for a change and the agent runs it on the simulator, reads the screen, taps through the flow and fixes what it finds. You get a change that already ran, and fewer rounds of review.',
    proof: 'Expensify',
    /** The files the Verify job in the hero produces. */
    evidence: [
      { kind: 'Screenshot', file: 'contact-form.png', from: 'screenshot' },
      { kind: 'Video', file: 'recording.mp4', from: 'record stop' },
      { kind: 'Replay', file: 'contacts.ad', from: '--save-script' },
    ],
    link: { text: 'Set up your agent', href: docs.agents },
  },
  outer: {
    label: 'On every pull request',
    headline: ['Verification that runs itself.', 'On every pull request.'],
    lede: 'Save a run that worked as an `.ad` script and replay it in CI with no model in the loop, or run a QA agent against each build. Reviewers get screenshots, logs and a JUnit report, on simulators or hosted devices.',
    proof: {
      text: 'The EAS Workflows QA agent template',
      href: 'https://github.com/callstackincubator/eas-agent-device',
    },
    /** An excerpt of examples/test-app/replays/checkout-form.ad. */
    file: 'checkout-form.ad',
    script: `context platform=ios timeout=60000
env APP_TARGET="Agent Device Tester"
open "\${APP_TARGET}" --relaunch
click "label=\\"Form\\""
fill id="field-name" "Ada Lovelace"
fill id="field-email" "ada@example.com"
click id="submit-order"
wait "Order summary" 5000`,
    ci: 'agent-device test ./workflows --reporter junit:./tmp/junit.xml',
    link: { text: 'Replay and E2E testing', href: docs.replay },
  },
  feedback: {
    label: 'From production back to the agent',
    headline: ['When something breaks,', 'the agent brings a repro.'],
    lede: 'Hand the agent the crash or the slow screen. It reproduces it on the device, captures the logs and network from that moment, and profiles the renders, so the fix starts from evidence.',
    /** The diagnosis `react-devtools profile stop` prints, from Debugging and profiling. */
    finding: {
      summary: 'React profile 8.3s: 8 commits, 1303ms rendering, 8 over 16ms (worst #6 188ms)',
      kind: 'memo-defeated',
      component: 'ContactRow',
      detail:
        'memo bypassed on 480/480 updates; new highlight (object) 480x, onSelect (function) 480x from ContactList',
      fix: 'wrap those props in useCallback/useMemo in ContactList',
    },
    link: { text: 'Debugging and profiling', href: docs.debugging },
  },

  /** The stories under "Who uses it", by adopter name. */
  stories: ['Expensify', 'T3 Code', 'TesterArmy'],

  /**
   * Watch and learn: talks on closing the loop with agents. Titles and channels as YouTube lists
   * them (checked through its oEmbed endpoint on 2026-10-27).
   */
  videos: [
    {
      id: 'hKeFaFedu1s',
      title: 'The Missing QA Loop for Mobile Agents',
      who: 'Interview with Michał Pierzchała',
      where: 'Callstack',
    },
    {
      id: 'W2rHuUEo9rk',
      title: 'Keynote',
      who: 'Mike Grabowski and Michał Pierzchała',
      where: 'Agent Conf 2026',
    },
    {
      id: 'gxgmEOXcNBQ',
      title: 'Automating Mobile QA with Cloud Agents',
      who: 'Michał Pierzchała',
      where: 'next app devCon 2026',
    },
    {
      id: 'kZDU-k5r9kE',
      title: 'Giving AI Agents Hands: Mobile Feedback Loops with Agent Device',
      who: 'Mike Grabowski',
      where: 'React Summit 2026',
    },
    {
      id: 'r5P0detC4bs',
      title: 'Cloud agents that test mobile apps on real devices',
      who: 'Vercel',
      where: 'Ship 26 London',
    },
    {
      id: 'n7fO3NFaT8M',
      title: 'Agent Device: AI agents meet mobile automation',
      who: 'Callstack livestream',
      where: 'Callstack',
    },
  ],

  /** Reading: articles and videos from the README. */
  reading: [
    {
      text: 'How Expensify uses agent-device for bug evidence and profiling',
      href: 'https://www.callstack.com/blog/how-expensify-uses-agent-device-for-mobile-bug-evidence-and-profiling',
    },
    {
      text: 'Build an AI QA agent for Expo apps with EAS Workflows',
      href: 'https://expo.dev/blog/build-an-ai-qa-agent-for-expo-apps-with-eas-workflows-in-minutes-today',
    },
    {
      text: 'Building mobile QA agents with Vercel Eve',
      href: 'https://www.callstack.com/blog/building-reviewable-mobile-qa-agents-with-vercel-eve',
    },
    {
      text: 'How we optimized agent-device for mobile app automation',
      href: 'https://www.callstack.com/blog/how-we-optimized-agent-device-for-mobile-app-automation',
    },
  ],
};
