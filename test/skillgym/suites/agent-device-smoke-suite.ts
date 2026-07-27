import { assert, commandMatcher, type Case, type CommandMatcher } from 'skillgym';
import {
  NOT_SETTLED_SAMPLE,
  PRIVATE_AX_RECOVERY_SAMPLE,
  SETTLE_DIFF_SAMPLE,
  SETTLE_TAIL_SAMPLE,
  sampleText,
} from '../../../scripts/help-conformance-sample-outputs.mjs';
import {
  extractCommandEvents,
  isActualLocalCliHelpProbe,
  isAllowedLocalCliHelpCommand,
} from './local-cli-help-policy.ts';

// This suite is deliberately small. It keeps only what an agentic runner can
// prove and a single non-agentic LLM call cannot: that a runner with the
// agent-device skill routes to it, consults LOCAL CLI help before answering
// (isActualLocalCliHelpProbe over observed command events), and reads
// captured agent-device output correctly in that agentic setting. Knowledge
// checks about command planning live in the cheaper, parser-validated help
// conformance bench (scripts/help-conformance-bench.mjs); live fixture
// behavior is owned by the iOS simulator e2e suite. The quoted samples are
// shared with the bench and pinned to the real renderers by
// scripts/__tests__/help-conformance-sample-outputs.test.ts.

type SessionReport = Parameters<typeof assert.skills.has>[0];
type AssertionContext = Parameters<Case['assert']>[1];
type OutputMatcher = string | RegExp | PlannedCommandMatcher;

interface PlannedCommandMatcher {
  kind: 'planned-command';
  matchers: CommandMatcher[];
}

interface OutputAbsenceContext {
  output: string;
  finalOutput: string;
  plannedReport: SessionReport;
}

const WORKSPACE_ROOT = process.cwd().replaceAll('\\', '/');
const APP_SOURCE = workspacePathPattern('examples/test-app', 'directory');
const REPO_SOURCE = workspacePathPattern('src', 'directory');
const COMMAND_DOCS = workspacePathPattern('website/docs/docs/commands.md', 'file');
const SUITE_FILE = workspacePathPattern('test/skillgym/suites/agent-device-smoke-suite.ts', 'file');

const BASE_INSTRUCTIONS = `
You are benchmarking agent-device command planning for a known fixture app.

Do not read project source files or project docs.
Do not inspect examples/test-app, src/, README.md, or website/docs.
Do not browse the web.
Use only this prompt plus local CLI help as private reference.
Do not execute live app/device commands while planning; only local CLI help commands are allowed before final output.
For local CLI help in this repo, use node bin/agent-device.mjs help or --help; final commands still use agent-device.
If the app contract names an expected id, selector, or visible text, include that exact target in a final verification command instead of stopping at the action that reaches or reveals it.
`.trim();

const DEFAULT_FINAL_OUTPUT_INSTRUCTIONS = `
Final output: only commands, one per line. Use agent-device for app/device automation; shell setup commands are allowed only when this prompt explicitly requires them. Any prose or Markdown fails.
Every final output line must start with agent-device.
Do not combine final commands with shell operators such as &&, ||, pipes, or semicolons.
`.trim();

function workspacePathPattern(relativePath: string, kind: 'directory' | 'file') {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const escapedRoot = escapeRegExp(WORKSPACE_ROOT);
  const escapedRelativePath = escapeRegExp(normalizedPath);
  const boundary = kind === 'directory' ? '(?:/|$)' : '$';
  return new RegExp(`^(?:${escapedRelativePath}|${escapedRoot}/${escapedRelativePath})${boundary}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPrompt(options: { contract: string[]; task: string; requireLocalCliHelp?: boolean }) {
  const contractLines = options.contract.map((line) => `- ${line}`).join('\n');
  const helpRequirement = options.requireLocalCliHelp
    ? '\nBefore planning, run node bin/agent-device.mjs --help and use that output as the command contract.'
    : '';
  return `${BASE_INSTRUCTIONS}${helpRequirement}\n${DEFAULT_FINAL_OUTPUT_INSTRUCTIONS}\n\nApp contract:\n${contractLines}\n\nTask:\n${options.task}`;
}

function assertAgentDeviceEvidence(report: SessionReport) {
  const detectedSkills = report.detectedSkills ?? [];
  const hasDetectedSkills = detectedSkills.length > 0;
  const hasBundledDeviceSkill = detectedSkills.some((skill) =>
    ['agent-device', 'dogfood'].includes(skill.skill),
  );

  // Some SkillGym runners do not expose skill telemetry. Keep this as a conditional routing
  // assertion instead of failing otherwise valid command-planning runs on missing metadata.
  if (hasDetectedSkills) {
    assert.soft.ok(
      hasBundledDeviceSkill,
      `Expected detectedSkills to include an agent-device bundled skill. Observed detectedSkills: ${detectedSkills
        .map((skill) => `${skill.skill} (${skill.confidence})`)
        .join(', ')}`,
    );
  }
}

function assertNoProjectSourceReads(report: SessionReport) {
  assert.soft.fileReads.notIncludes(report, APP_SOURCE, {
    explain: { question: 'Why did you read the fixture app source instead of using CLI help?' },
  });
  assert.soft.fileReads.notIncludes(report, REPO_SOURCE, {
    explain: { question: 'Why did you read repo source files instead of using CLI help?' },
  });
  assert.soft.fileReads.notIncludes(report, COMMAND_DOCS, {
    explain: { question: 'Why did you read website command docs instead of local CLI help?' },
  });
}

function plannedCommand(command: string): PlannedCommandMatcher {
  return plannedCommandAlternatives([command]);
}

function plannedCommandAlternatives(commands: string[]): PlannedCommandMatcher {
  return {
    kind: 'planned-command',
    matchers: commands.flatMap((command) => {
      const [executable, ...args] = commandParts(command);
      assert.ok(executable, 'planned command must not be empty');

      return [
        commandMatcher('agent-device').args(executable, ...args),
        commandMatcher(executable).args(...args),
      ];
    }),
  };
}

function assertOutputs(finalOutput: string, matchers: OutputMatcher[]) {
  const output = normalizedFinalOutput(finalOutput);
  const plannedReport = plannedCommandReport(output);
  for (const matcher of matchers) {
    if (isPlannedCommandMatcher(matcher)) {
      assertPlannedCommandIncludes(plannedReport, matcher);
      continue;
    }

    assert.output.includes(normalizedOutputReport(output), matcher);
  }
}

function assertNoOutputs(finalOutput: string, matchers: OutputMatcher[]) {
  const output = normalizedFinalOutput(finalOutput);
  const plannedReport = plannedCommandReport(output);
  const context = { output, finalOutput, plannedReport };

  for (const matcher of matchers) {
    assertOutputAbsent(context, matcher);
  }
}

function assertOutputAbsent(context: OutputAbsenceContext, matcher: OutputMatcher) {
  if (isPlannedCommandMatcher(matcher)) {
    assertPlannedCommandNotIncludes(context.plannedReport, matcher);
    return;
  }

  if (typeof matcher === 'string') {
    assertStringOutputAbsent(context, matcher);
    return;
  }

  assert.doesNotMatch(context.output, matcher);
}

function assertStringOutputAbsent(context: OutputAbsenceContext, matcher: string) {
  assert.ok(
    !context.output.includes(matcher),
    `Expected final output not to include ${JSON.stringify(matcher)}. Observed final output: ${context.finalOutput}`,
  );
}

function isPlannedCommandMatcher(matcher: OutputMatcher): matcher is PlannedCommandMatcher {
  return (
    typeof matcher === 'object' &&
    !(matcher instanceof RegExp) &&
    matcher.kind === 'planned-command'
  );
}

function assertPlannedCommandIncludes(report: SessionReport, matcher: PlannedCommandMatcher) {
  if (matcher.matchers.length === 1) {
    assert.commands.includes(report, matcher.matchers[0]!);
    return;
  }

  const failures: Error[] = [];
  for (const command of matcher.matchers) {
    try {
      assert.commands.includes(report, command);
      return;
    } catch (error) {
      failures.push(error as Error);
    }
  }

  assert.fail(failures.map((error) => error.message).join('\n'));
}

function assertPlannedCommandNotIncludes(report: SessionReport, matcher: PlannedCommandMatcher) {
  for (const command of matcher.matchers) {
    assert.commands.notIncludes(report, command);
  }
}

function normalizedFinalOutput(output: string): string {
  return output
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}

function plannedCommandReport(output: string): SessionReport {
  return {
    events: output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((command) => ({ type: 'command' as const, command })),
  } as SessionReport;
}

function normalizedOutputReport(output: string): SessionReport {
  return { finalOutput: output } as SessionReport;
}

function commandParts(command: string): string[] {
  return command.split(' ').filter(Boolean);
}

function assertExpectedOutput(
  report: SessionReport,
  ctx: AssertionContext,
  matchers: OutputMatcher[] = [],
) {
  if (matchers.length === 0) {
    assert.output.notEmpty(report);
    return;
  }

  assertOutputs(ctx.finalOutput(), matchers);
}

function assertOnlyLocalCliHelpCommands(report: SessionReport) {
  const commandEvents = extractCommandEvents(report);
  const forbiddenCommands = commandEvents.filter(
    (command) => !isAllowedLocalCliHelpCommand(command),
  );

  assert.deepEqual(
    forbiddenCommands,
    [],
    `Expected planning runs to execute only local CLI help commands. Observed runtime commands: ${forbiddenCommands
      .map((command) => JSON.stringify(command))
      .join(', ')}`,
  );
}

function assertLocalCliHelpUsed(report: SessionReport) {
  const commandEvents = extractCommandEvents(report);
  assert.ok(
    commandEvents.some(isActualLocalCliHelpProbe),
    'Expected the planning run to inspect local CLI help before answering.',
  );
}

const RAW_COORDINATE_TARGET =
  /(?:^|\n)(?:agent-device\s+)?(?:click|fill|press)\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/i;
const SHELL_OUTPUT_PROJECTION = /(?:2>\s*\/dev\/null|\|\s*(?:jq|grep|head|tail)\b)/i;
const IOS_TEST_APP_DEV_BUILD_OPEN = new RegExp(
  String.raw`(?:^|\n)(?:agent-device\s+)?open\s+` +
    String.raw`(?:(?:"Agent Device Tester")|(?:'Agent Device Tester')|com\.callstack\.agentdevicelab)\b`,
  'i',
);

function makeCase(options: {
  id: string;
  contract: string[];
  task: string;
  tags?: string[];
  outputs?: OutputMatcher[];
  forbiddenOutputs?: OutputMatcher[];
  allowOnlyLocalCliHelpCommands?: boolean;
  requireLocalCliHelp?: boolean;
}): Case {
  return {
    id: options.id,
    tags: options.tags,
    prompt: buildPrompt({
      contract: options.contract,
      task: options.task,
      requireLocalCliHelp: options.requireLocalCliHelp,
    }),
    assert(report, ctx) {
      assertAgentDeviceEvidence(report);
      assertNoProjectSourceReads(report);
      assert.soft.fileReads.notIncludes(report, SUITE_FILE, {
        explain: { question: 'Why did you inspect the benchmark suite while answering?' },
      });
      assertExpectedOutput(report, ctx, options.outputs);
      assertNoOutputs(ctx.finalOutput(), options.forbiddenOutputs ?? []);
      if (options.allowOnlyLocalCliHelpCommands) assertOnlyLocalCliHelpCommands(report);
      if (options.requireLocalCliHelp) assertLocalCliHelpUsed(report);
    },
  };
}

function withTags(tags: string[], cases: Case[]): Case[] {
  return cases.map((testCase) => ({
    ...testCase,
    tags: [...new Set([...(testCase.tags ?? []), ...tags])],
  }));
}

function quiz(sample: { command: string; output: string }, question: string): string {
  return `Read this previous agent-device output, then plan the next command:

${sampleText(sample)}

${question}`;
}

// Routing smoke: proves the runner reaches a sane plan for the fixture app
// from the skill plus local help, without reading project source.
const FIXTURE_SMOKE_CASES: Case[] = [
  makeCase({
    id: 'open-and-snapshot',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS',
      'Launch context: installed Expo development build',
      'Bundle identifier: com.callstack.agentdevicelab',
    ],
    task: 'Plan the commands to open Agent Device Tester as an installed Expo development build on iOS, take a snapshot -i to verify the app UI loaded, then close.',
    outputs: [IOS_TEST_APP_DEV_BUILD_OPEN, /snapshot -i/i, plannedCommand('close')],
    forbiddenOutputs: [
      /open\s+["']Expo Go["']/i,
      /host\.exp\.Exponent/i,
      /exp:\/\/127\.0\.0\.1:8081/i,
    ],
    // The suite's claim is "a sane plan from the skill plus local help" — so
    // the run must actually consult local help, and must not execute anything
    // else while planning. Without these, the case can pass on model prior
    // alone and the claim is unproven.
    allowOnlyLocalCliHelpCommands: true,
    requireLocalCliHelp: true,
  }),
];

// Output-interpretation cases: each run must consult real local CLI help
// (requireLocalCliHelp + the local-cli-help-policy events check) and then read
// captured agent-device output correctly. The bench carries the same cases as
// single-call knowledge checks; here they measure the agentic path.
const SKILL_GUIDANCE_CASES: Case[] = [
  makeCase({
    id: 'settle-diff-is-observation',
    contract: [
      'App name: Agent Device Tester',
      'Previous command output is from agent-device, not a task description',
      'The task was to confirm the feed-search UI and close the session',
    ],
    task: quiz(
      SETTLE_TAIL_SAMPLE,
      'Use the output already shown to determine whether the feed-search UI is present, then close the session. What command should run next?',
    ),
    outputs: [plannedCommand('close')],
    forbiddenOutputs: [
      plannedCommand('snapshot'),
      plannedCommand('wait'),
      plannedCommand('find'),
      plannedCommand('get'),
      plannedCommand('is'),
      plannedCommandAlternatives(['press', 'click']),
    ],
    allowOnlyLocalCliHelpCommands: true,
    requireLocalCliHelp: true,
  }),
  makeCase({
    id: 'sample-output-settled-diff-next-target',
    contract: [
      'App name: Agent Device Tester',
      'Previous command output is from agent-device, not a task description',
      'Need to continue from the settled diff without taking another snapshot',
    ],
    task: quiz(
      SETTLE_DIFF_SAMPLE,
      'The task is to open the matching account result. What command should run next?',
    ),
    outputs: [
      plannedCommandAlternatives(['press', 'click', 'tap']),
      /@e64(?:~s\d+)?\b|(?:label|text)=(?:["']@callstack\.com["']|@callstack\.com)/i,
      /--settle\b/i,
    ],
    forbiddenOutputs: [
      plannedCommand('snapshot'),
      plannedCommand('wait stable'),
      plannedCommand('fill'),
      RAW_COORDINATE_TARGET,
    ],
    allowOnlyLocalCliHelpCommands: true,
    requireLocalCliHelp: true,
  }),
  makeCase({
    id: 'sample-output-not-settled-needs-observe',
    contract: [
      'App name: Agent Device Tester',
      'Previous command output is from agent-device, not a task description',
      'The next target is unknown because no settled tree was printed',
      'Old refs may be stale after the mutation',
    ],
    task: quiz(
      NOT_SETTLED_SAMPLE,
      'The next target is not known yet. What command should run next?',
    ),
    outputs: [/(?:^|\n)(?:agent-device\s+)?(?:wait\b|snapshot\b[^\n]*-i\b)/i],
    forbiddenOutputs: [
      /(?:^|\n)(?:agent-device\s+)?(?:press|click|fill|longpress)\s+@e\d+/i,
      RAW_COORDINATE_TARGET,
      SHELL_OUTPUT_PROJECTION,
    ],
    allowOnlyLocalCliHelpCommands: true,
    requireLocalCliHelp: true,
  }),
  makeCase({
    id: 'sample-output-private-ax-recovery-continues',
    contract: [
      'Platform: iOS',
      'Previous command output is from agent-device, not a task description',
      'The fallback snapshot still exposed an actionable Search button',
      'Need to open Search and observe the resulting UI',
    ],
    task: quiz(
      PRIVATE_AX_RECOVERY_SAMPLE,
      'Treat the recovery warning as a warning, not a fatal error. Use the exposed Search button. What command should run next?',
    ),
    outputs: [
      plannedCommandAlternatives(['press', 'click', 'tap']),
      /@e5\b|label=(?:["']Search["']|Search)/i,
      /(?:--settle\b|(?:^|\n)(?:agent-device\s+)?snapshot\b[^\n]*-i\b)/i,
    ],
    forbiddenOutputs: [
      /--debug|--verbose/i,
      plannedCommand('screenshot'),
      plannedCommand('close'),
      plannedCommand('help'),
      RAW_COORDINATE_TARGET,
    ],
    allowOnlyLocalCliHelpCommands: true,
    requireLocalCliHelp: true,
  }),
];

const suite: Case[] = [
  ...withTags(['fixture-smoke'], FIXTURE_SMOKE_CASES),
  ...withTags(['skill-guidance'], SKILL_GUIDANCE_CASES),
];

export default suite;
