import { assert, commandMatcher, type Case, type CommandMatcher } from 'skillgym';

type SessionReport = Parameters<typeof assert.skills.has>[0];
type AssertionContext = Parameters<Case['assert']>[1];
type OutputMatcher = string | RegExp | PlannedCommandMatcher | TopLevelPlannedCommandMatcher;

interface PlannedCommandMatcher {
  kind: 'planned-command';
  matchers: CommandMatcher[];
}

interface TopLevelPlannedCommandMatcher {
  kind: 'top-level-planned-command';
  commands: string[];
}

interface OutputAbsenceContext {
  output: string;
  finalOutput: string;
  plannedReport: SessionReport;
}

interface CommandEventRecord {
  type?: unknown;
  command?: unknown;
  args?: {
    command?: unknown;
    cmd?: unknown;
  };
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

function buildPrompt(options: { contract: string[]; task: string }) {
  const contractLines = options.contract.map((line) => `- ${line}`).join('\n');
  return `${BASE_INSTRUCTIONS}\n\nApp contract:\n${contractLines}\n\nTask:\n${options.task}`;
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

function topLevelPlannedCommand(command: string): TopLevelPlannedCommandMatcher {
  return topLevelPlannedCommandAlternatives([command]);
}

function topLevelPlannedCommandAlternatives(commands: string[]): TopLevelPlannedCommandMatcher {
  return {
    kind: 'top-level-planned-command',
    commands: commands.map((command) => {
      const [executable, ...args] = commandParts(command);
      assert.ok(executable, 'top-level planned command must not be empty');
      assert.equal(args.length, 0, 'top-level planned command matches only one command token');
      return executable;
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

    if (isTopLevelPlannedCommandMatcher(matcher)) {
      assertTopLevelPlannedCommandIncludes(output, matcher);
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

  if (isTopLevelPlannedCommandMatcher(matcher)) {
    assertTopLevelPlannedCommandNotIncludes(context.output, matcher);
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

function isTopLevelPlannedCommandMatcher(
  matcher: OutputMatcher,
): matcher is TopLevelPlannedCommandMatcher {
  return (
    typeof matcher === 'object' &&
    !(matcher instanceof RegExp) &&
    matcher.kind === 'top-level-planned-command'
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

function assertTopLevelPlannedCommandIncludes(
  output: string,
  matcher: TopLevelPlannedCommandMatcher,
) {
  const observed = topLevelPlannedCommands(output);
  assert.ok(
    observed.some((command) => matcher.commands.includes(command)),
    `Expected final output to include top-level command ${matcher.commands
      .map((command) => JSON.stringify(command))
      .join(' or ')}. Observed top-level commands: ${observed
      .map((command) => JSON.stringify(command))
      .join(', ')}`,
  );
}

function assertTopLevelPlannedCommandNotIncludes(
  output: string,
  matcher: TopLevelPlannedCommandMatcher,
) {
  const observed = topLevelPlannedCommands(output);
  const forbidden = observed.filter((command) => matcher.commands.includes(command));
  assert.deepEqual(
    forbidden,
    [],
    `Expected final output not to include top-level command ${matcher.commands
      .map((command) => JSON.stringify(command))
      .join(' or ')}. Observed top-level commands: ${observed
      .map((command) => JSON.stringify(command))
      .join(', ')}`,
  );
}

function topLevelPlannedCommands(output: string): string[] {
  return normalizedFinalOutput(output)
    .split('\n')
    .map(topLevelPlannedCommandFromLine)
    .filter((command): command is string => command !== undefined);
}

function topLevelPlannedCommandFromLine(line: string): string | undefined {
  const [executable, firstArg] = commandParts(line.trim());
  if (executable === undefined) {
    return undefined;
  }

  return topLevelCommandToken(executable, firstArg);
}

function topLevelCommandToken(executable: string, firstArg: string | undefined): string {
  return executable === 'agent-device' && firstArg !== undefined ? firstArg : executable;
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

function assertFinalOutputAgentDeviceCommandsOnly(finalOutput: string) {
  const output = normalizedFinalOutput(finalOutput);
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(lines.length > 0, 'Expected final output to contain agent-device commands.');

  for (const line of lines) {
    assert.match(
      line,
      /^agent-device\s+\S+/,
      `Expected final output line to be one agent-device command with no prose: ${JSON.stringify(line)}`,
    );
    assert.doesNotMatch(
      line,
      /\s(?:&&|\|\||\|)\s|;/,
      `Expected one command per line without shell chaining: ${JSON.stringify(line)}`,
    );
  }
}

function assertOnlyLocalCliHelpCommands(report: SessionReport) {
  const commandEvents = extractCommandEvents(report);
  const forbiddenCommands = commandEvents.filter((command) => !isLocalCliHelpCommand(command));

  assert.deepEqual(
    forbiddenCommands,
    [],
    `Expected planning runs to execute only local CLI help commands. Observed runtime commands: ${forbiddenCommands
      .map((command) => JSON.stringify(command))
      .join(', ')}`,
  );
}

function extractCommandEvents(report: SessionReport): string[] {
  const events = (report as { events?: unknown[] }).events ?? [];
  return events.flatMap(commandFromEvent);
}

function commandFromEvent(event: unknown): string[] {
  if (!isCommandEventRecord(event)) {
    return [];
  }

  const command = directCommandEvent(event) ?? toolCallCommandEvent(event);
  return command === undefined ? [] : [command];
}

function isCommandEventRecord(event: unknown): event is CommandEventRecord {
  return typeof event === 'object' && event !== null;
}

function directCommandEvent(record: CommandEventRecord): string | undefined {
  if (record.type === 'command' && typeof record.command === 'string') {
    return record.command;
  }

  return undefined;
}

function toolCallCommandEvent(record: CommandEventRecord): string | undefined {
  const command = record.args?.command ?? record.args?.cmd;
  if (record.type === 'toolCall' && typeof command === 'string') {
    return command;
  }

  return undefined;
}

function isLocalCliHelpCommand(command: string) {
  const strippedCommand = command
    .trim()
    .replace(/^\/bin\/zsh\s+-lc\s+'(.+)'$/, '$1')
    .trim();

  return splitShellHelpProbe(strippedCommand).every(isLocalCliHelpSegment);
}

function splitShellHelpProbe(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isLocalCliHelpSegment(command: string) {
  const helpToken = '[^\\s;&|]+';
  return (
    new RegExp(
      `^(?:node\\s+bin\\/agent-device\\.mjs|agent-device)\\s+(?:(?:help(?:\\s+${helpToken})*)|(?:${helpToken}\\s+)?--help)(?:\\s+2>&1)?$`,
    ).test(command) ||
    /^printf\s+["'][^"']*["']$/.test(command) ||
    command === 'cat'
  );
}

const RAW_COORDINATE_TARGET =
  /(?:^|\n)(?:agent-device\s+)?(?:click|fill|press)\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/i;
const PSEUDO_ASSERTION_COMMAND = /(?:^|\n)\s*(?:assert|assertVisible|waitFor|waitForText)\b/i;
const RAW_RECT_SNAPSHOT = /snapshot\b(?=[^\n]*-i\b)(?=[^\n]*(?:--json|--raw))/i;
const SHELL_OUTPUT_PROJECTION = /(?:2>\s*\/dev\/null|\|\s*(?:jq|grep|head|tail)\b)/i;
const ROLE_NAME_SELECTOR_KEY = /(?:^|[\s'"])button\s*=/i;
const BOUNDED_PROFILE_SLOW = /react-devtools\s+profile\s+slow\b[^\n]*--limit\s+(?:5|10)\b/i;
const BOUNDED_PROFILE_RERENDERS =
  /react-devtools\s+profile\s+rerenders\b[^\n]*--limit\s+(?:5|10)\b/i;
const BOUNDED_PROFILE_TIMELINE =
  /react-devtools\s+profile\s+timeline\b[^\n]*--limit\s+(?:10|20)\b/i;
const BROAD_PROFILE_SLOW_LIMIT =
  /react-devtools\s+profile\s+slow\b[^\n]*--limit\s+(?:[5-9]\d|[1-9]\d{2,})\b/i;
const CDP_MEMORY_USAGE_SAMPLE = /cdp\s+memory\s+usage\s+sample\b/i;
const CDP_MEMORY_SNAPSHOT_CAPTURE = /cdp\s+memory\s+snapshot\s+capture\b/i;
const IOS_EXPO_GO_OPEN =
  /(?:^|\n)(?:agent-device\s+)?open\s+["']Expo Go["']\s+["']?exp:\/\/127\.0\.0\.1:8081["']?/i;
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
  strictFinalOutput?: boolean;
  allowOnlyLocalCliHelpCommands?: boolean;
}): Case {
  return {
    id: options.id,
    tags: options.tags,
    prompt: buildPrompt({ contract: options.contract, task: options.task }),
    assert(report, ctx) {
      assertAgentDeviceEvidence(report);
      assertNoProjectSourceReads(report);
      assert.soft.fileReads.notIncludes(report, SUITE_FILE, {
        explain: { question: 'Why did you inspect the benchmark suite while answering?' },
      });
      assertExpectedOutput(report, ctx, options.outputs);
      assertNoOutputs(ctx.finalOutput(), options.forbiddenOutputs ?? []);
      if (options.strictFinalOutput) {
        assertFinalOutputAgentDeviceCommandsOnly(ctx.finalOutput());
      }
      if (options.allowOnlyLocalCliHelpCommands) {
        assertOnlyLocalCliHelpCommands(report);
      }
    },
  };
}

function withTags(tags: string[], cases: Case[]): Case[] {
  return cases.map((testCase) => ({
    ...testCase,
    tags: [...new Set([...(testCase.tags ?? []), ...tags])],
  }));
}

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
  }),
  makeCase({
    id: 'home-dismiss-notice',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'testID=dismiss-notice',
      'visible text: Release notice',
    ],
    task: 'Assume Agent Device Tester is already open on the Home tab. Plan the commands to dismiss the Release notice using the dismiss-notice testID, verify it is gone with diff snapshot -i, then close.',
    outputs: [
      /dismiss-notice/i,
      /(?:diff snapshot -i|snapshot\b.*(?:-i\b.*--diff|--diff\b.*-i\b))/i,
      plannedCommand('close'),
    ],
  }),
  makeCase({
    id: 'home-confirm-alert',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'testID=home-open-modal',
      'Opening it shows a native confirmation alert',
      'Home tab selector: label="Home"',
    ],
    task: 'Assume Agent Device Tester is already open on the Home tab. Plan the commands to open the confirmation alert, dismiss it using alert wait + alert dismiss, then verify the app is still on Home.',
    outputs: [
      /home-open-modal/i,
      plannedCommand('alert wait'),
      plannedCommand('alert dismiss'),
      /label=(?:["']Home["']|Home)/i,
    ],
  }),
  makeCase({
    id: 'home-refresh-metrics',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'testID=refresh-metrics',
      'visible loading text: Refreshing metrics...',
    ],
    task: 'Assume Agent Device Tester is already open on Home. Plan the commands to tap Refresh metrics, wait for "Refreshing metrics..." to appear, then verify the loading state is gone.',
    outputs: [/refresh-metrics/i, plannedCommand('wait'), /Refreshing metrics/i],
  }),
  makeCase({
    id: 'home-toggle-online',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'testID=toggle-online',
      'visible badge text after disabling: Offline',
    ],
    task: 'Assume Agent Device Tester is open on Home. Plan the commands to toggle Lab online off and verify the Offline badge is visible.',
    outputs: [/toggle-online/i, /Offline/i],
  }),
  makeCase({
    id: 'catalog-search-debounce',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'testID=catalog-search',
      'Search should respect debounce timing',
    ],
    task: 'Assume Agent Device Tester is on the Catalog tab. Plan the commands to fill the search field with "tart" using --delay-ms to respect the debounce, then wait for results to update.',
    outputs: [/catalog-search/i, /--delay-ms/i, plannedCommand('wait')],
  }),
  makeCase({
    id: 'catalog-filter-bakery',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'category chip: category-bakery',
      'visible product after filtering: Berry Tart',
    ],
    task: 'Assume Agent Device Tester is on the Catalog tab. Plan the commands to select the Bakery category and verify Berry Tart is visible.',
    outputs: [/(?:category-bakery|Bakery)/i, /Berry Tart/i],
  }),
  makeCase({
    id: 'catalog-favorite-toggle',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'testID=favorite-citrus-kit',
      'label after toggling favorite: Saved',
    ],
    task: 'Assume Agent Device Tester is on the Catalog tab. Plan the commands to toggle favorite for Citrus Starter Kit and verify the label changes to Saved.',
    outputs: [/favorite-citrus-kit/i, /Saved/i],
  }),
  makeCase({
    id: 'catalog-add-to-cart',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'testID=add-pepper-mix',
      'visible text after add: In cart: 1',
    ],
    task: 'Assume Agent Device Tester is on the Catalog tab. Plan the commands to add Pepper Mix to the cart and verify the card shows In cart: 1.',
    outputs: [/add-pepper-mix/i, /In cart: 1/i],
  }),
  makeCase({
    id: 'catalog-scroll-footer',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'testID=catalog-footer',
      'footer visible text: Seasonal footer target',
    ],
    task: 'Assume Agent Device Tester is on the Catalog tab. Plan the commands to scroll to the Seasonal footer target card using the scroll command.',
    outputs: [plannedCommand('scroll'), /(?:catalog-footer|Seasonal footer|down)/i],
    forbiddenOutputs: [/scrollintoview/i],
  }),
  makeCase({
    id: 'product-open-details',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'testID=details-citrus-kit',
      'Product detail screen has testID=product-title',
    ],
    task: 'Assume Agent Device Tester is on the Catalog tab. Plan the commands to open Citrus Starter Kit details and verify the product title is visible.',
    outputs: [/details-citrus-kit/i, /product-title/i],
  }),
  makeCase({
    id: 'product-quantity',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: product detail',
      'testID=quantity-increase',
      'testID=quantity-decrease',
      'testID=quantity-value',
    ],
    task: 'Assume Agent Device Tester is already on a product detail screen. Plan the commands to increase quantity once, decrease it once, and get the quantity value through the durable quantity-value id rather than ambiguous visible number text.',
    outputs: [
      /quantity-increase/i,
      /quantity-decrease/i,
      plannedCommand('get text'),
      /id=(?:["']quantity-value["']|quantity-value)/i,
    ],
    forbiddenOutputs: [/get text ['"]?2['"]?/i, /wait text ['"]?2['"]?/i, /label=["']2["']/i],
  }),
  makeCase({
    id: 'product-note-append',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: product detail',
      'testID=product-note',
      'Use append semantics rather than replacement',
    ],
    task: 'Assume Agent Device Tester is already on a product detail screen. Plan the commands to append "Handle with care" to the product note using press + type (not fill).',
    outputs: [/product-note/i, plannedCommand('press'), plannedCommand('type')],
    forbiddenOutputs: [plannedCommand('fill'), /(?:^|\n)(?:agent-device\s+)?type\s+@/i],
  }),
  makeCase({
    id: 'product-save-to-cart',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: product detail',
      'testID=product-save',
      'toast text after saving: Cart updated',
    ],
    task: 'Assume Agent Device Tester is already on a product detail screen. Plan the commands to press Save to cart and verify the Cart updated toast appears.',
    outputs: [/product-save/i, /Cart updated/i],
  }),
  makeCase({
    id: 'form-validation-errors',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'testID=submit-order',
      'validation errors card uses testID=form-errors',
    ],
    task: 'Assume Agent Device Tester is on the Checkout form tab. Plan the commands to submit with empty fields and verify the validation errors card is visible.',
    outputs: [/submit-order/i, /form-errors/i],
  }),
  makeCase({
    id: 'form-success-submit',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'testID=field-name',
      'testID=field-email',
      'testID=checkbox-agree',
      'success card uses testID=form-success',
    ],
    task: 'Assume Agent Device Tester is on the Checkout form tab. Plan the commands to fill name and email, check order confirmation, submit, and verify the Order summary card is visible.',
    outputs: [/field-name/i, /field-email/i, /checkbox-agree/i, /form-success/i],
  }),
  makeCase({
    id: 'form-keyboard-dismiss-ios-fallback',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'Current screen: Checkout form tab',
      'testID=field-name',
      'keyboard dismiss already returned UNSUPPORTED_OPERATION',
      'visible app keyboard close control: Done',
    ],
    task: 'Assume Agent Device Tester is on the Checkout form tab. Plan the fallback commands to focus the Full name field, close the iOS keyboard through the visible app control, and verify the field remains visible.',
    outputs: [/field-name/i, /Done/i, plannedCommandAlternatives(['press', 'click'])],
    forbiddenOutputs: [plannedCommand('keyboard dismiss'), plannedCommand('back')],
  }),
  makeCase({
    id: 'form-keyboard-dismiss-ios-done-control',
    contract: [
      'Platform: iOS',
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'testID=field-name',
      'The focused field shows an iOS keyboard toolbar with a visible Done control',
    ],
    task: 'Plan the commands to focus the Full name field and dismiss the iOS keyboard without manually pressing Done.',
    outputs: [/field-name/i, /keyboard dismiss/i],
    forbiddenOutputs: [plannedCommand('back'), /press\s+.*Done/i, /click\s+.*Done/i],
  }),
  makeCase({
    id: 'form-reset',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'testID=reset-form',
      'Full name field can be checked through id="field-name" or id="full-name"',
      'Validation errors can be checked through id="form-errors", id="full-name-error", or visible text "Required"',
      'toast text after reset: Form cleared',
    ],
    task: 'Assume Agent Device Tester is on the Checkout form tab after validation errors. Plan the commands to press Reset form, verify the Form cleared toast appears, verify validation errors are hidden, and verify the Full name field state is cleared.',
    outputs: [
      /reset-form/i,
      /Form cleared/i,
      /(?:form-errors|full-name-error|Required)/i,
      /(?:field-name|full-name)/i,
    ],
  }),
  makeCase({
    id: 'settings-toggle-preferences',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Settings tab',
      'testID=toggle-notifications',
      'testID=toggle-reduced-motion',
    ],
    task: 'Assume Agent Device Tester is on the Settings tab. Plan the commands to toggle Push notifications and Reduced motion.',
    outputs: [/toggle-notifications/i, /toggle-reduced-motion/i],
  }),
  makeCase({
    id: 'settings-diagnostics-error',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Settings tab',
      'testID=load-diagnostics',
      'error panel uses testID=diagnostics-error',
    ],
    task: 'Assume Agent Device Tester is on the Settings tab. Plan the commands to load diagnostics, wait for the error state, and verify the diagnostics error panel is visible.',
    outputs: [/load-diagnostics/i, /diagnostics-error/i],
  }),
  makeCase({
    id: 'settings-diagnostics-retry',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Settings tab',
      'testID=load-diagnostics',
      'testID=retry-diagnostics',
      'ready state uses testID=diagnostics-ready',
    ],
    task: 'Assume Agent Device Tester is on the Settings tab. Plan the commands to load diagnostics, wait for the error state, retry diagnostics, then verify the Ready badge is visible.',
    outputs: [/load-diagnostics/i, /retry-diagnostics/i, /diagnostics-ready/i],
  }),
  makeCase({
    id: 'settings-reset-alert',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Settings tab',
      'testID=reset-lab',
      'native alert title: Reset Agent Device Tester?',
    ],
    task: 'Assume Agent Device Tester is on the Settings tab. Plan the commands to trigger Reset lab state, then accept the native alert using alert wait + alert accept.',
    outputs: [/reset-lab/i, plannedCommand('alert wait'), plannedCommand('alert accept')],
  }),
  makeCase({
    id: 'home-accessibility-audit',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'Compare visible UI with the accessibility tree',
    ],
    task: 'Assume Agent Device Tester is on Home. Plan the commands to capture a screenshot and a snapshot to compare visible UI vs accessibility tree.',
    outputs: [/screenshot/i, /snapshot/i],
  }),
];

const SKILL_GUIDANCE_CASES: Case[] = [
  makeCase({
    id: 'web-first-use-runs-managed-setup',
    contract: [
      'Platform: Web',
      'URL to verify: https://example.com',
      'No web backend has been set up in this state directory yet',
      'Web automation uses the managed backend through agent-device, not direct backend commands',
    ],
    task: 'Plan the first-run commands to set up web automation, open the URL, inspect interactive refs, and close the session.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?web\s+setup\b[\s\S]*(?:^|\n)(?:agent-device\s+)?open\s+["']?https:\/\/example\.com["']?\s+--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?snapshot\s+-i\s+--platform\s+web\b/i,
      /(?:^|\n)(?:agent-device\s+)?close\s+--platform\s+web\b/i,
    ],
    forbiddenOutputs: [/agent-browser/i, /(?:^|\n)\s*(?:npm|pnpm|npx)\b/i],
    strictFinalOutput: true,
  }),
  makeCase({
    id: 'web-minimal-browser-loop',
    contract: [
      'Platform: web',
      'Target URL: https://example.com/login',
      'agent-device web setup already passed',
      'Fresh interactive snapshot will expose @e12 as the email field and @e13 as the Continue button',
      'Expected success text after submit: Welcome',
      'Visual evidence path: ./artifacts/web-login.png',
    ],
    task: 'Plan the minimal agent-device web commands to open the page, inspect interactive refs, fill the email field, click Continue, wait for the success text, capture a screenshot, and close.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?open\s+https:\/\/example\.com\/login\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?snapshot\b[^\n]*-i\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?fill\s+@e12\s+["']?[^"'\n]+@[^"'\n]+["']?[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?(?:click|press)\s+@e13\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?wait\s+text\s+["']Welcome["'][^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?screenshot\s+\.\/artifacts\/web-login\.png\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?close\b[^\n]*--platform\s+web/i,
    ],
    forbiddenOutputs: [
      /agent-browser/i,
      plannedCommand('boot'),
      plannedCommand('apps'),
      plannedCommand('install'),
      plannedCommand('alert'),
      plannedCommand('keyboard'),
      plannedCommand('react-devtools'),
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'web-network-dump',
    contract: [
      'Platform: web',
      'Target URL: https://example.com/account',
      'agent-device web setup already passed',
      'Need recent browser network requests with headers after loading the page',
    ],
    task: 'Plan the agent-device commands to open the web page, inspect recent browser network requests with headers, and close.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?open\s+https:\/\/example\.com\/account\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?network\s+dump\b[^\n]*(?:--include\s+headers|\bheaders\b)[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?close\b[^\n]*--platform\s+web/i,
    ],
    forbiddenOutputs: [/agent-browser/i, plannedCommand('logs')],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'web-fixed-layout-viewport-and-fullshot',
    contract: [
      'Platform: web',
      'Target URL: https://example.com/app',
      'agent-device web setup already passed',
      'The app uses a fixed 100vh layout, so a taller viewport is needed before taking evidence screenshots',
      'Visual evidence path: ./artifacts/web-app.png',
    ],
    task: 'Plan the agent-device commands to open the web app, resize the viewport to 1280x900, capture a full-page screenshot, and close.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?open\s+https:\/\/example\.com\/app\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?viewport\s+1280\s+900\b[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?screenshot\s+\.\/artifacts\/web-app\.png\b[^\n]*(?:--fullscreen|--full|-f)[^\n]*--platform\s+web/i,
      /(?:^|\n)(?:agent-device\s+)?close\b[^\n]*--platform\s+web/i,
    ],
    forbiddenOutputs: [/agent-browser/i, /--full-page\b/i],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'inspect-visible-text-readonly',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'visible status badge text: Online',
      'No interaction is needed to answer this task',
    ],
    task: 'Plan the minimal read-only command to verify whether the Online badge is visible. Do not request interactive refs or mutate the UI.',
    outputs: [/(?:^|\n)(?:agent-device\s+)?(?:snapshot|is|find)(?:\s|$)/i, /Online/i],
    forbiddenOutputs: [
      /snapshot -i/i,
      plannedCommand('click'),
      plannedCommand('fill'),
      plannedCommand('press'),
    ],
  }),
  makeCase({
    id: 'target-ref-after-interactive-snapshot',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'The target control has no stable selector in the task context',
      'Fresh interactive snapshot will expose the target as @e12',
    ],
    task: 'Plan the commands to capture fresh interactive refs, press the target control with its @e12 ref, then verify the nearby change with diff snapshot -i.',
    outputs: [
      /snapshot -i/i,
      /(?:^|\n)(?:agent-device\s+)?(?:click|press)\s+@e12\b/i,
      /(?:diff snapshot -i|snapshot\b.*(?:-i\b.*--diff|--diff\b.*-i\b))/i,
    ],
    forbiddenOutputs: [RAW_COORDINATE_TARGET, /\btestID=/i],
  }),
  makeCase({
    id: 'post-type-refresh-interactive-refs',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Chat composer',
      'The previous command typed into a focused text input',
      'The keyboard appeared, so previous @e refs are stale',
      'The Send control has no stable selector in the task context',
      'Fresh interactive snapshot will expose Send as @e9',
      'Submitted text to verify: sent with agent-device v0.15',
      'Use wait/find for that exact text or diff snapshot -i; do not use a plain full snapshot for verification',
    ],
    task: 'Plan the next commands to refresh only current interactive refs, press Send, then verify the message was submitted.',
    outputs: [
      /snapshot -i/i,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@e9\b/i,
      /(?:diff snapshot -i|wait\b.*sent with agent-device v0\.15|find\b.*sent with agent-device v0\.15|snapshot\b.*-i)/i,
    ],
    forbiddenOutputs: [
      /(?:^|\n)(?:agent-device\s+)?snapshot(?![^\n]*\s-i\b)/i,
      plannedCommand('screenshot'),
      RAW_COORDINATE_TARGET,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@e(?!9\b)\d+\b/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'ios-disabled-row-raw-rect-fallback',
    contract: [
      'Platform: iOS simulator',
      'Current screen: Orders list',
      'Fresh interactive snapshot shows @e12 [disabled] hittable:false label "Order #1042"',
      'press @e12 already returned success, but diff snapshot showed no navigation',
      'Raw JSON rect center for @e12 is x=196 y=318',
    ],
    task: 'Plan the fallback commands to inspect raw snapshot rects, press the row center, then verify the nearby change.',
    outputs: [
      RAW_RECT_SNAPSHOT,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+196\s+318\b/i,
      /(?:diff snapshot|snapshot\b.*--diff)/i,
    ],
    forbiddenOutputs: [/(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@e12\b/i, /scrollintoview/i],
  }),
  makeCase({
    id: 'truncated-text-input-scope-ref',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'Fresh interactive snapshot already shows @e7 [textinput] "Delivery instructions" [preview:"Leave at side gate..." truncated]',
      'Need the full text value of that truncated input before deciding whether to edit it',
    ],
    task: 'Plan the command to expand the truncated Delivery instructions text input using the current @e7 ref.',
    outputs: [
      plannedCommand('snapshot'),
      /(?:^|\n)(?:agent-device\s+)?snapshot\b.*(?:-s|--scope)\s+@e7\b/i,
    ],
    forbiddenOutputs: [
      /snapshot --raw/i,
      plannedCommand('get'),
      plannedCommand('fill'),
      plannedCommand('type'),
      plannedCommand('press'),
      RAW_COORDINATE_TARGET,
    ],
  }),
  makeCase({
    id: 'target-selector-for-durable-field',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'Durable selector: id="catalog-search"',
      'Search should respect debounce timing',
    ],
    task: 'Plan the commands to fill the catalog search field through the durable id selector with "tart" using --delay-ms, then wait for results.',
    outputs: [
      plannedCommand('fill'),
      /id=(?:["']catalog-search["']|catalog-search)/i,
      /--delay-ms/i,
      plannedCommand('wait'),
    ],
    forbiddenOutputs: [
      RAW_COORDINATE_TARGET,
      /(?:^|\n)(?:agent-device\s+)?type\s+@/i,
      /--selector\b/i,
      /--text\b/i,
    ],
  }),
  makeCase({
    id: 'network-search-settle-then-wait',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog search tab',
      'Search field selector: id="catalog-search"',
      'Search results are network-backed and may arrive after the local UI has gone quiet',
      'Expected result text: Alpenglow Trail Mug',
    ],
    task: 'Plan commands to search for "alpenglow" with the durable field selector, use --settle for the fill action, then wait for the network-backed result text. Do not verify this by taking repeated snapshots.',
    outputs: [
      plannedCommand('fill'),
      /id=(?:["']catalog-search["']|catalog-search)/i,
      /alpenglow/i,
      /--settle\b/i,
      plannedCommand('wait text'),
      /Alpenglow Trail Mug/i,
    ],
    forbiddenOutputs: [
      SHELL_OUTPUT_PROJECTION,
      /(?:^|\n)(?:agent-device\s+)?snapshot\b[\s\S]*(?:^|\n)(?:agent-device\s+)?snapshot\b/i,
      RAW_COORDINATE_TARGET,
    ],
  }),
  makeCase({
    id: 'raw-output-before-shell-projection',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'The target control has no stable selector in the task context',
      'Fresh interactive snapshot will expose the target as @e12',
      'agent-device output includes refs, warnings, hints, and diagnostics needed for the next step',
    ],
    task: 'Plan robust commands to inspect interactive refs, press the discovered @e12 target, then verify the nearby change. Do not pipe, grep, jq, or hide command output while exploring.',
    outputs: [
      /snapshot -i/i,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@e12\b/i,
      /(?:diff snapshot -i|snapshot\b.*(?:-i\b.*--diff|--diff\b.*-i\b)|wait\b|find\b)/i,
    ],
    forbiddenOutputs: [SHELL_OUTPUT_PROJECTION, RAW_COORDINATE_TARGET],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'selector-role-filter-not-role-key',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Feed directory',
      'Fresh interactive snapshot shows @e37 [button] "Search for more feeds"',
      'If a role filter is needed, the supported selector shape is role=button label="Search for more feeds"',
      'button="Search for more feeds" is not a valid selector key',
      'Need the resulting UI after pressing this control',
    ],
    task: 'Plan the command to press Search for more feeds with settle. Prefer the visible @e37 ref or a valid selector; do not invent a role-name selector key.',
    outputs: [
      plannedCommandAlternatives(['press', 'click']),
      /(?:@e37|label=(?:["']Search for more feeds["']|Search for more feeds)|role=button)/i,
      /--settle\b/i,
    ],
    forbiddenOutputs: [ROLE_NAME_SELECTOR_KEY, RAW_COORDINATE_TARGET],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'settle-diff-is-observation',
    contract: [
      'App name: Agent Device Tester',
      'Previous command: press @e37 --settle',
      'The settled diff already showed + @e64 [text-field] "Search"',
      'The settled diff already showed + @e65 [text] "Recent searches"',
      'The task was to confirm the feed-search UI and close the session',
      'No more refs or visible evidence are needed',
    ],
    task: 'Plan the next command. Do not take another snapshot just to re-read evidence that was already present in the settled diff.',
    outputs: [plannedCommand('close')],
    forbiddenOutputs: [
      plannedCommand('snapshot'),
      plannedCommand('wait'),
      plannedCommand('find'),
      plannedCommand('get'),
      plannedCommand('is'),
      plannedCommandAlternatives(['press', 'click']),
    ],
  }),
  makeCase({
    id: 'sample-output-settled-diff-next-target',
    contract: [
      'App name: Agent Device Tester',
      'Previous command output is from agent-device, not a task description',
      'Need to continue from the settled diff without taking another snapshot',
      'Need to open the matching account result',
    ],
    task: `Read this previous agent-device output, then plan the next command:

agent-device fill 'id="account-search"' "callstack" --settle
Filled id="account-search" with "callstack"
settled:true refsGeneration: 12
Changed:
+ @e64 [button] "@callstack.com"
+ @e65 [text] "Callstack"

Use the result ref exposed by the settled diff to open the account with settle. Do not re-read the same screen first.`,
    outputs: [
      plannedCommandAlternatives(['press', 'click', 'tap']),
      /@e64(?:~s12)?\b|label=(?:["']@callstack\.com["']|@callstack\.com)/i,
      /--settle\b/i,
    ],
    forbiddenOutputs: [
      plannedCommand('snapshot'),
      plannedCommand('wait stable'),
      plannedCommand('fill'),
      RAW_COORDINATE_TARGET,
    ],
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'sample-output-not-settled-needs-observe',
    contract: [
      'App name: Agent Device Tester',
      'Previous command output is from agent-device, not a task description',
      'The next target is unknown because no settled tree was printed',
      'Old refs may be stale after the mutation',
    ],
    task: `Read this previous agent-device output, then plan the next command:

agent-device press @e12 --settle
Pressed @e12
not settled after 10000ms
Hint: UI kept changing. Run agent-device wait stable or agent-device snapshot -i before the next ref-based action.

Follow the output hint before attempting another ref-based action.`,
    outputs: [/(?:^|\n)(?:agent-device\s+)?(?:wait\s+stable|snapshot\b[^\n]*-i\b)/i],
    forbiddenOutputs: [
      /(?:^|\n)(?:agent-device\s+)?(?:press|click|fill|longpress)\s+@e\d+/i,
      RAW_COORDINATE_TARGET,
      SHELL_OUTPUT_PROJECTION,
    ],
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'sample-output-private-ax-recovery-continues',
    contract: [
      'Platform: iOS',
      'Previous command output is from agent-device, not a task description',
      'The fallback snapshot still exposed an actionable Search button',
      'Need to open Search and observe the resulting UI',
    ],
    task: `Read this previous agent-device output, then plan the next command:

agent-device snapshot -i
Recovered this snapshot with the private-ax accessibility backend.
Detected overly complex accessibility tree. Falling back to another snapshot backend.
It's OK to continue. For more information, rerun with --debug.

@e5 [button] "Search"
@e8 [tab] "Home" selected

Treat the recovery message as a warning, not a fatal error. Use the exposed Search button.`,
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
  }),
  makeCase({
    id: 'text-replace-uses-fill',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'Field selector: id="field-email"',
      'Existing field value must be replaced',
    ],
    task: 'Plan the command to replace the Email field value with "qa@example.com".',
    outputs: [
      plannedCommand('fill'),
      /id=(?:["']field-email["']|field-email)/i,
      /qa@example\.com/i,
    ],
    forbiddenOutputs: [plannedCommand('type'), /(?:^|\n)(?:agent-device\s+)?fill\s+\d+\s+\d+/i],
  }),
  makeCase({
    id: 'empty-fill-not-clear-field',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'Search field selector: id="catalog-search"',
      'Visible clear control selector: id="clear-search"',
      'Need to clear the existing search text',
      'fill <target> "" is not supported',
    ],
    task: 'Plan the supported command to clear the search field without using empty fill replacement.',
    outputs: [
      /id=(?:["']clear-search["']|clear-search)/i,
      plannedCommandAlternatives(['press', 'click']),
    ],
    forbiddenOutputs: [
      /fill\b[^\n]*(?:id=["']catalog-search["']|catalog-search)[^\n]*(?:""|''|\s$)/i,
      plannedCommand('type'),
      /\bclear\s+field\b/i,
    ],
  }),
  makeCase({
    id: 'ios-allow-paste-prefill-only',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'App reads UIPasteboard.general when opened',
      'iOS Allow Paste system prompt is suppressed under XCUITest automation',
      'Need to test app behavior when pasteboard contains: some text',
    ],
    task: 'Plan commands to prefill the simulator pasteboard and open the app for paste-driven behavior. Do not try to automate the Allow Paste system dialog.',
    outputs: [plannedCommand('clipboard'), /write/i, /some text/i, plannedCommand('open')],
    forbiddenOutputs: [
      /Allow Paste/i,
      /alert (?:wait|accept|dismiss)/i,
      /\bxcrun\b/i,
      /\bsimctl\b/i,
    ],
  }),
  makeCase({
    id: 'offscreen-target-scroll-resnapshot',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'Visible-first snapshot says [off-screen below] "Seasonal footer target"',
      'Off-screen refs are discovery hints, not actionable refs',
      'The target is below the viewport, not necessarily at the absolute bottom of the list',
      'Do not use scroll bottom for this task',
    ],
    task: 'Plan the commands to reach the Seasonal footer target from the off-screen summary, then refresh interactive refs before acting or verifying.',
    outputs: [plannedCommand('scroll'), /\bdown\b/i, /snapshot -i/i],
    forbiddenOutputs: [
      /scrollintoview/i,
      /\bscroll\s+bottom\b/i,
      /(?:^|\n)(?:agent-device\s+)?(?:click|press)\s+@\S+/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'android-tv-focus-uses-tv-remote',
    contract: [
      'Platform: Android TV emulator',
      'Target selector is not currently focused',
      'TV apps are focus-first: move focus with D-pad/remote buttons before selecting',
      'Visual focus evidence is required before selecting',
      'Raw ADB keyevent is the old workaround; use agent-device command surface instead',
      'If you inspect CLI help, run it raw; do not pipe it through head, grep, jq, or tail',
      'Final answer must be agent-device command lines only, with no prose or introduction',
    ],
    task: 'Plan commands to move focus down twice, capture overlay-ref screenshot evidence, and select the focused Android TV control.',
    outputs: [
      plannedCommand('tv-remote'),
      /\bdown\b/i,
      /screenshot\b[^\n]*--overlay-refs/i,
      /\bselect\b/i,
    ],
    forbiddenOutputs: [
      /\badb\b/i,
      /\bkeyevent\b/i,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@(?:e\d+|ref)\b/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'android-tv-remote-longpress-preset',
    contract: [
      'Platform: Android TV emulator',
      'The focused control is a TV remote target',
      'Use the agent-device TV remote command surface, not raw ADB keyevents',
      'For a held TV remote button, use the tv-remote longpress preset',
      'Final answer must be agent-device command lines only, with no prose or introduction',
    ],
    task: 'Plan the command to hold the focused Android TV select button with the default TV remote longpress preset.',
    outputs: [plannedCommand('tv-remote'), /\blongpress\b/i, /\bselect\b/i],
    forbiddenOutputs: [/\badb\b/i, /\bkeyevent\b/i, /--duration-ms/i, plannedCommand('longpress')],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'ios-composite-horizontal-tabs-coordinate-fallback',
    contract: [
      'Platform: iOS simulator',
      'Current screen: Catalog filters',
      'Horizontal filter tabs are collapsed into one [seekbar] in snapshot -i',
      'The individual Bakery tab has no @ref or selector on iOS',
      'Raw JSON plus visual inspection gives Bakery center x=84 y=220',
    ],
    task: 'Plan commands to handle the missing child refs by inspecting raw rects, tapping the Bakery center, and verifying the selected filter changed.',
    outputs: [
      RAW_RECT_SNAPSHOT,
      /(?:^|\n)(?:agent-device\s+(?:--platform\s+ios\s+)?)?(?:press|click)\s+84\s+220\b/i,
      /(?:diff snapshot -i|snapshot\b.*(?:-i\b.*--diff|--diff\b.*-i\b)|snapshot\b.*-i|Berry Tart|Bakery)/i,
    ],
    forbiddenOutputs: [
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@(?:e\d+|ref)\b/i,
      /scrollintoview/i,
    ],
  }),
  makeCase({
    id: 'list-text-presence-prefers-wait-text',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'List content loads asynchronously',
      'Expected list item text: Trip ideas',
      'No interaction is needed; this is a presence check for visible text in a list',
    ],
    task: 'Plan the robust read-only command to wait for the Trip ideas list text to appear.',
    outputs: [plannedCommand('wait'), /Trip ideas/i],
    forbiddenOutputs: [plannedCommand('is visible'), /snapshot -i/i, plannedCommand('press')],
  }),
  makeCase({
    id: 'navigation-back-in-app',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: product detail',
      'Goal: return to the Catalog tab through normal app navigation',
      'No visible Catalog tab selector or nav-back selector is currently exposed',
    ],
    task: 'Plan the command to go back to Catalog using the app-owned back command.',
    outputs: [plannedCommand('back')],
    forbiddenOutputs: [/back\s+--system/i],
  }),
  makeCase({
    id: 'navigation-back-ambiguous-use-visible-nav',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: nested product detail',
      'Previous back command navigated to an unexpected screen',
      'Visible app nav button selector: id="nav-back"',
      'Goal: return one level inside the app, not trigger system back',
    ],
    task: 'Plan the next navigation command using the visible app-owned control instead of retrying back.',
    outputs: [/nav-back/i, plannedCommandAlternatives(['press', 'click'])],
    forbiddenOutputs: [plannedCommand('back'), /back\s+--system/i],
  }),
  makeCase({
    id: 'setup-unknown-app-discover-first',
    contract: [
      'Platform: Android',
      'Target app display name is known: Agent Device Tester',
      'Package id is unknown',
      'No app session is open yet',
    ],
    task: 'Plan the bootstrap commands to discover the correct Android device and app identifier, then open the discovered app.',
    outputs: [plannedCommand('devices'), plannedCommand('apps'), plannedCommand('open')],
    forbiddenOutputs: [/com\.agent\.device\.tester/i, /com\.example/i],
  }),
  makeCase({
    id: 'install-artifact-before-open',
    contract: [
      'Platform: Android',
      'Known artifact path: ./dist/agent-device-tester.apk',
      'Known package after install: com.callstack.agentdevicetester',
      'The task requires installing the artifact',
    ],
    task: 'Plan the commands to install the APK artifact, then open the installed package in a fresh runtime state.',
    outputs: [
      plannedCommand('install'),
      /\.\/dist\/agent-device-tester\.apk/i,
      plannedCommand('open'),
      /--relaunch/i,
    ],
    forbiddenOutputs: [/open\s+\.\/dist\/agent-device-tester\.apk/i],
  }),
  makeCase({
    id: 'install-from-github-artifact-before-open',
    contract: [
      'Platform: Android',
      'Install source: GitHub Actions artifact callstack/agent-device:agent-device-tester-apk',
      'Known package after install: com.callstack.agentdevicetester',
      'Remote daemon can resolve the artifact server-side',
    ],
    task: 'Plan commands to install from the GitHub Actions artifact, then open the installed package in fresh runtime state.',
    outputs: [
      plannedCommand('install-from-source'),
      /--github-actions-artifact\s+callstack\/agent-device:agent-device-tester-apk/i,
      plannedCommand('open'),
      /com\.callstack\.agentdevicetester/i,
      /--relaunch/i,
    ],
    forbiddenOutputs: [
      /curl\b/i,
      /gh\s+(?:run|artifact|download)/i,
      /open\s+.*agent-device-tester-apk/i,
    ],
  }),
  makeCase({
    id: 'hidden-info-do-not-force-ui',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'Question: what is the hidden promo code?',
      'The current screen does not expose any promo code text or selector',
      'No interaction was requested',
    ],
    task: 'Plan the minimal read-only command to inspect exposed UI without typing, navigating, or mutating the app to reveal hidden information.',
    outputs: [plannedCommand('snapshot')],
    forbiddenOutputs: [
      plannedCommand('press'),
      plannedCommand('click'),
      plannedCommand('fill'),
      plannedCommand('type'),
      plannedCommand('open'),
    ],
  }),
  makeCase({
    id: 'metro-reload-dev-loop',
    contract: [
      'App name: Agent Device Tester',
      'React Native dev build is already open and connected to Metro',
      'Only JavaScript changed',
    ],
    task: 'Plan the commands to reload the running app after the JS change, then verify the Home screen is visible.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?metro\s+reload(?:\s|$)/i,
      /(?:^|\n)(?:agent-device\s+)?(?:snapshot\b|find\b[^\n]*Home|is\b[^\n]*Home|wait\b[^\n]*Home)/i,
    ],
    forbiddenOutputs: [/open\b.*--relaunch/i, /(?:^|\n)(?:agent-device\s+)?screenshot\b/i],
  }),
  makeCase({
    id: 'ios-rn-two-worktrees-one-native-build',
    contract: [
      'App name: React Navigation Example',
      'Platform: iOS simulators',
      'The app is already installed on both simulators',
      'Worktree A Metro is already running on 127.0.0.1:8081',
      'Worktree B Metro is already running on 127.0.0.1:8082',
      'Use iPhone 17 for worktree A and iPhone 17 Pro for worktree B',
      'Use separate sessions rn-a and rn-b',
      'Do not rebuild, reinstall, or run package manager commands',
    ],
    task: 'Plan the agent-device commands to launch the same installed React Native iOS app against each worktree Metro instance and verify both sessions with interactive snapshots.',
    outputs: [
      /open\s+["']?React Navigation Example["']?(?=[^\n]*--platform ios)(?=[^\n]*--device ["']?iPhone 17["']?)(?=[^\n]*--session rn-a)(?=[^\n]*--metro-host 127\.0\.0\.1)(?=[^\n]*--metro-port 8081)(?=[^\n]*--relaunch)/i,
      /open\s+["']?React Navigation Example["']?(?=[^\n]*--platform ios)(?=[^\n]*--device ["']?iPhone 17 Pro["']?)(?=[^\n]*--session rn-b)(?=[^\n]*--metro-host 127\.0\.0\.1)(?=[^\n]*--metro-port 8082)(?=[^\n]*--relaunch)/i,
      /snapshot -i(?=[^\n]*--platform ios)(?=[^\n]*--session rn-a)/i,
      /snapshot -i(?=[^\n]*--platform ios)(?=[^\n]*--session rn-b)/i,
    ],
    forbiddenOutputs: [
      /run-ios/i,
      /reinstall/i,
      /install\b/i,
      /yarn|pnpm|npm|npx/i,
      /adb\s+reverse/i,
      /--device "iPhone 17"[^\n]*--session rn-b/i,
      /--device "iPhone 17 Pro"[^\n]*--session rn-a/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'rn-warning-overlay-dismiss-before-tap',
    contract: [
      'App name: Agent Device Tester',
      'Current screen after opening will trigger console.warn',
      'Fresh interactive snapshot should show the React Native warning overlay',
      'Fresh interactive snapshot shows @e4 label="×" for the small close icon',
      'The warning overlay can obscure UI and intercept taps',
      'Target selector after dismissing overlay: id="submit-order"',
    ],
    task: 'Plan commands to identify the warning overlay in snapshot -i, dismiss it with the React Native overlay command, verify the overlay is gone with diff snapshot -i or a fresh snapshot -i, then press the submit target.',
    outputs: [
      /snapshot -i[\s\S]*react-native\s+dismiss-overlay[\s\S]*(?:diff snapshot -i|snapshot\b.*-i)/i,
      /submit-order/i,
    ],
    forbiddenOutputs: [
      plannedCommand('screenshot'),
      RAW_COORDINATE_TARGET,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\b[^\n]*submit-order[\s\S]*(?:Dismiss|Close)/i,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@e4\b/i,
      /(?:press|click)\b[^\n]*(?:warning|LogBox)/i,
      /alert accept/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'rn-collapsed-warning-banner-expand-dismiss',
    contract: [
      'App name: Agent Device Tester',
      'Current screen has a collapsed React Native warning banner',
      'Fresh interactive snapshot shows @e12 label="!, Open debugger to view warnings."',
      'Dismiss is not visible until the warning banner is pressed',
      'The post-expansion Dismiss/Close ref is unknown in this prompt; use find or a label selector instead of inventing a new @e ref',
      'Target selector after dismissing overlay: id="submit-order"',
    ],
    task: 'Plan commands to dismiss the collapsed warning banner with the React Native overlay command, re-snapshot, then press id="submit-order". Do not stop after dismissing the overlay.',
    outputs: [
      /(?:snapshot -i[\s\S]*)?react-native\s+dismiss-overlay[\s\S]*snapshot -i[\s\S]*submit-order/i,
    ],
    forbiddenOutputs: [
      plannedCommand('screenshot'),
      RAW_COORDINATE_TARGET,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\b[^\n]*submit-order[\s\S]*(?:@e12|Dismiss|Close)/i,
      /(?:^|\n)(?:agent-device\s+)?(?:press|click)\s+@e12\b/i,
      /alert accept/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'rn-error-overlay-human-flag',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android',
      'Fresh interactive snapshot shows a React Native error overlay',
      'Overlay controls include Dismiss and Reload JS',
      'React DevTools is connected',
      'The overlay is unrelated to the requested checkout task but should be reported',
      'Checkout target selector after dismissing overlay: id="submit-order"',
      'Need overlay screenshot evidence with refs before dismissing it',
    ],
    task: 'Plan commands to capture the error overlay using screenshot --overlay-refs, inspect React DevTools errors, dismiss only the unrelated overlay with the React Native overlay command, re-snapshot, then continue to id="submit-order".',
    outputs: [
      /snapshot(?:\s+-i)?/i,
      /screenshot\b[^\n]*--overlay-refs/i,
      plannedCommand('react-devtools errors'),
      plannedCommand('react-native dismiss-overlay'),
      /(?:diff snapshot -i|snapshot(?:\s+-i)?)/i,
      /submit-order/i,
    ],
    forbiddenOutputs: [
      RAW_COORDINATE_TARGET,
      /(?:press|click)\b[^\n]*(?:Dismiss|Close|warning|LogBox|RedBox)/i,
      /alert accept/i,
      /ignore/i,
    ],
  }),
  makeCase({
    id: 'rn-redbox-stack-dismiss-before-continuing',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android',
      'Fresh interactive snapshot shows a full-screen React Native RedBox stack trace',
      'Stack includes useOnyx.ts:80:43 and LHNOptionsList.tsx:77',
      'Overlay controls include Dismiss and Minimize',
      'The RedBox may be caused by an infinite render loop',
      'Target selector after dismissing overlay: id="submit-order"',
    ],
    task: 'Plan commands to recognize the RedBox stack trace, run the React Native overlay command so it dismisses the overlay, re-snapshot, then continue to id="submit-order" while reporting the RedBox later.',
    outputs: [
      /snapshot -i[\s\S]*react-native\s+dismiss-overlay[\s\S]*snapshot -i[\s\S]*submit-order/i,
    ],
    forbiddenOutputs: [
      RAW_COORDINATE_TARGET,
      /(?:press|click)\b[^\n]*(?:Dismiss|Minimize)/i,
      /alert accept/i,
      /failed nav|navigation failed/i,
    ],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'expo-go-ios-project-url',
    contract: [
      'Platform: iOS simulator',
      'Launch context: Expo Go',
      'Project URL: exp://127.0.0.1:8081',
      'The native bundle id for the project is not installed separately',
      'The final command must include --platform ios',
    ],
    task: 'Plan the command to launch the Expo project in Expo Go on iOS without inventing a native bundle id.',
    outputs: [IOS_EXPO_GO_OPEN, /--platform ios/i],
    forbiddenOutputs: [
      /open\s+Agent Device Tester/i,
      /host\.exp\.Exponent/i,
      /com\.(?:callstack|example|agent)/i,
    ],
  }),
  makeCase({
    id: 'expo-go-ios-runner-splash-retry-host-shell',
    contract: [
      'Platform: iOS simulator',
      'Launch context: Expo Go',
      'Project URL: exp://127.0.0.1:8081',
      'Previous command open exp://127.0.0.1:8081 returned Opened',
      'Fresh snapshot -i showed only the Agent Device Runner splash',
      'Expo Go is available as a host shell',
    ],
    task: 'Plan the next commands to recover by opening the project through Expo Go and verifying the app UI loaded.',
    outputs: [IOS_EXPO_GO_OPEN, /snapshot -i/i],
    forbiddenOutputs: [
      /open\s+Agent Device Runner/i,
      /open\s+Agent Device Tester/i,
      /com\.(?:callstack|example|agent)/i,
      /host\.exp\.Exponent/i,
    ],
  }),
  makeCase({
    id: 'expo-go-ios-after-app-id-miss',
    contract: [
      'Platform: iOS simulator',
      'Target app display name: Agent Device Tester',
      'Previous apps lookup did not list Agent Device Tester',
      'Previous apps lookup did list Expo Go',
      'Project URL: exp://127.0.0.1:8081',
    ],
    task: 'Plan the next command to launch the project after the app-id lookup miss without inventing a native bundle id.',
    outputs: [IOS_EXPO_GO_OPEN],
    forbiddenOutputs: [
      /open-url/i,
      /open\s+Agent Device Tester/i,
      /com\.(?:callstack|example|agent)/i,
      /host\.exp\.Exponent/i,
    ],
  }),
  makeCase({
    id: 'expo-go-android-url-only',
    contract: [
      'Platform: Android',
      'Launch context: Expo Go',
      'Project URL: exp://10.0.2.2:8081',
      'Android Expo URLs can be opened directly when no specific app package must be forced',
    ],
    task: 'Plan the command to launch the Expo project on Android using the project URL.',
    outputs: [plannedCommand('open'), /exp:\/\/10\.0\.2\.2:8081/i, /--platform android/i],
    forbiddenOutputs: [
      /open\s+(?:"Expo Go"|Expo\s+Go)\s+exp:\/\//i,
      /--activity/i,
      /host\.exp\.exponent/i,
    ],
  }),
  makeCase({
    id: 'android-local-metro-reverse-before-url-open',
    contract: [
      'Platform: Android',
      'Launch context: Expo Go because the user provided an exp:// project URL',
      'Local Metro port: 8082',
      'Project URL: exp://127.0.0.1:8082',
      'Direct Android localhost URL opens auto-configure host reachability',
      'On Android, open the URL target directly; do not use the iOS host-plus-URL form with "Expo Go"',
      'Every agent-device command must target Android explicitly with --platform android',
      'Do not assume every React Native app is Expo; this one is Expo only because an exp:// URL was provided',
    ],
    task: 'Plan the explicit Android direct-URL commands to open the Expo project URL on local Metro port 8082 and verify the app UI with an interactive snapshot.',
    outputs: [
      plannedCommand('open'),
      /exp:\/\/127\.0\.0\.1:8082/i,
      /--platform android/i,
      /snapshot -i/i,
    ],
    forbiddenOutputs: [
      /adb\s+reverse/i,
      /exp:\/\/10\.0\.2\.2:8082/i,
      /open\s+(?:"Expo Go"|Expo\s+Go)\s+exp:\/\//i,
      /com\.(?:expensify|agent|example)/i,
      /--activity/i,
    ],
  }),
  makeCase({
    id: 'debug-logs-short-window',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Settings tab',
      'Repro button selector: id="load-diagnostics"',
      'Need app logs only for the retry failure window',
    ],
    task: 'Plan the commands to clear and restart logs, mark the repro window, trigger diagnostics, and inspect the log path without dumping a whole stale log into context.',
    outputs: [/logs clear --restart/i, /logs mark/i, /load-diagnostics/i, /logs path/i],
    forbiddenOutputs: [/cat .*log/i, /tail -n \+1/i],
  }),
  makeCase({
    id: 'ios-simulator-open-launch-console',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'Need initial launch stdout/stderr in artifacts/launch-console.log',
      'After launch, verify the app UI loaded with an interactive snapshot',
    ],
    task: 'Plan commands for launching the iOS simulator app while capturing the initial launch console output, then verify the UI loaded.',
    outputs: [
      /open\b[^\n]*Agent Device Tester[^\n]*--launch-console artifacts\/launch-console\.log/i,
      /snapshot -i/i,
    ],
    forbiddenOutputs: [/simctl\b/i, /--console-pty/i, /\bsleep\s+\d+/i],
  }),
  makeCase({
    id: 'ios-simulator-open-device-hub',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'User explicitly wants Xcode Device Hub when surfacing the simulator',
      'After launch, verify the app UI loaded with an interactive snapshot',
    ],
    task: 'Plan commands for launching the iOS simulator app through Xcode Device Hub, then verify the UI loaded.',
    outputs: [/open\b[^\n]*Agent Device Tester[^\n]*--device-hub/i, /snapshot -i/i],
    forbiddenOutputs: [/--no-device-hub/i, /simctl\b/i, /\bsleep\s+\d+/i],
  }),
  makeCase({
    id: 'debug-network-session-dump',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Settings tab',
      'Diagnostics load triggers HTTP traffic logged by the app',
      'Repro button selector: id="load-diagnostics"',
      'Need request and response headers',
    ],
    task: 'Plan the commands to reproduce the diagnostics request and inspect recent session network traffic with headers.',
    outputs: [
      /load-diagnostics/i,
      plannedCommand('network'),
      /(?:dump|log)/i,
      /(?:--include\s+headers|\bheaders\b|network dump\b[^\n]*\ball\b)/i,
    ],
    forbiddenOutputs: [/logs path/i, /cat .*log/i],
  }),
  makeCase({
    id: 'debug-symbols-apple-crash',
    contract: [
      'Artifact: artifacts/crash.ips',
      'Build products directory: ./build',
      'Need a symbolicated crash artifact at artifacts/crash-symbolicated.ips',
      'Do not inspect or paste the full crash into context',
    ],
    task: 'Plan the command to symbolicate this Apple crash report with local debug symbols.',
    outputs: [
      plannedCommand('debug'),
      /symbols/i,
      /--artifact\s+artifacts\/crash\.ips/i,
      /--search-path\s+\.\/build/i,
      /--out\s+artifacts\/crash-symbolicated\.ips/i,
    ],
    forbiddenOutputs: [
      plannedCommand('perf'),
      plannedCommand('logs'),
      /cat\s+artifacts\/crash\.ips/i,
      /react-devtools/i,
    ],
  }),
  makeCase({
    id: 'android-open-verify-ui',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android',
      'Package id: com.agentdevice.tester',
      'Expected loaded text: Agent Device Tester',
      'Need to verify the UI loaded after relaunch',
    ],
    task: 'Plan commands to open the Android package with a relaunch and verify the app UI loaded. Do not rely on screenshot-only verification.',
    outputs: [
      plannedCommand('open'),
      /com\.agentdevice\.tester/i,
      /--relaunch/i,
      /(?:wait(?:\s+text)?|is visible|find)\b[^\n]*Agent Device Tester/i,
    ],
    forbiddenOutputs: [plannedCommand('screenshot')],
  }),
  makeCase({
    id: 'android-action-sheet-document-scan-wait',
    contract: [
      'App name: Document Fixture',
      'Platform: Android',
      'Current screen: chat composer',
      'Action sheet trigger selector: id="composer-actions"',
      'Scan option text: Scan document',
      'Expected result text after upload: Document uploaded',
      'Android camera permission may appear as a runtime permission dialog',
    ],
    task: 'Plan commands to open the composer action sheet, choose Scan document, handle any visible permission prompt, and wait for the upload result.',
    outputs: [
      /composer-actions/i,
      /Scan document/i,
      /alert (?:wait|accept)|Allow|snapshot -i/i,
      /wait\b[^\n]*Document uploaded/i,
    ],
    forbiddenOutputs: [RAW_COORDINATE_TARGET, PSEUDO_ASSERTION_COMMAND, /settings permission/i],
  }),
  makeCase({
    id: 'evidence-screenshot-overlay-refs',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Catalog tab',
      'The bug report needs visual proof and tappable-region context for icon-only controls',
    ],
    task: 'Plan the command to capture screenshot evidence with current interactive ref overlays.',
    outputs: [plannedCommand('screenshot'), /--overlay-refs/i],
    forbiddenOutputs: [/snapshot --raw/i],
  }),
  makeCase({
    id: 'ios-ax-unavailable-screenshot-coordinate-recovery',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'Current screen returned a sparse snapshot: Snapshot: 1 node (truncated)',
      'The hint says snapshot state is invalid or unavailable for this screen',
      'If screenshot shows the Home Screen or another app, the hint says to open the app again first',
      'The visible screenshot shows the next tab target centered near x=124 y=817',
      'Accessibility may work again after leaving this screen',
    ],
    task: 'Plan fallback commands to recover from the AX-unavailable snapshot state: capture visual truth, navigate out using the visible coordinate, then try AX again on the next screen.',
    outputs: [plannedCommand('screenshot'), /(?:click|press)\s+124\s+817/i, /snapshot -i/i],
    forbiddenOutputs: [/--overlay-refs/i, /@e\d+/i, /(?:find|wait|is|get)\b/i, /snapshot --raw/i],
    strictFinalOutput: true,
    allowOnlyLocalCliHelpCommands: true,
  }),
  makeCase({
    id: 'perf-session-metrics',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'No startup sample exists until the app is opened',
      'Need session startup, memory, and CPU data as JSON',
    ],
    task: 'Plan the commands to open the app first if needed, then collect session performance metrics as JSON.',
    outputs: [
      plannedCommand('open'),
      plannedCommandAlternatives(['perf metrics', 'metrics']),
      /--json/i,
    ],
    forbiddenOutputs: [plannedCommand('network')],
  }),
  makeCase({
    id: 'perf-session-frames',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android emulator',
      'The app is already open',
      'Need focused frame and jank health as JSON',
    ],
    task: 'Plan the command to collect focused frame and jank health as JSON without collecting React component render profiling.',
    outputs: [plannedCommand('perf frames'), /--json/i],
    forbiddenOutputs: [plannedCommand('react-devtools'), plannedCommand('network')],
  }),
  makeCase({
    id: 'perf-memory-diagnostics',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android emulator',
      'The app is already open',
      'Symptom: memory grows after repeatedly opening the Settings diagnostics screen',
      'Need a compact first-pass memory sample, then a Java heap artifact only if the sample suggests escalation',
    ],
    task: 'Plan the commands for memory diagnostics without using React DevTools or debug symbols.',
    outputs: [
      plannedCommand('perf memory sample'),
      /--json/i,
      plannedCommand('perf memory snapshot'),
      /--kind\s+android-hprof/i,
      /--out\s+\S+\.hprof/i,
    ],
    forbiddenOutputs: [
      plannedCommand('react-devtools'),
      plannedCommand('debug'),
      plannedCommand('perf frames'),
    ],
  }),
  makeCase({
    id: 'react-native-js-heap-leak-cdp-triplet',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'Metro is running at http://127.0.0.1:8081',
      'The app exposes a React Native CDP target through Metro',
      'Symptom: JavaScript heap grows after opening and closing the Cart screen',
      'Need proof that retained JS objects survive cleanup, plus shortest useful retaining paths',
      'This is not a native/process memory investigation',
    ],
    task: 'Plan a bounded React Native JS heap leak workflow using cdp: select the Metro CDP target, sample heap usage, capture baseline/action/cleanup snapshots, diff them, run leak-triplet, and inspect retainers for a leaked node.',
    outputs: [
      plannedCommand('cdp target list'),
      /--url\s+http:\/\/127\.0\.0\.1:8081/i,
      plannedCommand('cdp target select'),
      CDP_MEMORY_SNAPSHOT_CAPTURE,
      /--name\s+baseline/i,
      /--name\s+(?:after-action|action)/i,
      /--name\s+cleanup/i,
      plannedCommand('cdp memory snapshot diff'),
      plannedCommand('cdp memory snapshot leak-triplet'),
      plannedCommand('cdp memory snapshot retainers'),
    ],
    forbiddenOutputs: [
      plannedCommand('perf memory sample'),
      plannedCommand('perf memory snapshot'),
      plannedCommand('react-devtools'),
      plannedCommand('cdp profile cpu'),
      plannedCommand('cdp trace'),
      plannedCommand('cdp network'),
      plannedCommand('cdp console'),
    ],
  }),
  makeCase({
    id: 'react-native-js-heap-quick-signal-cdp',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android emulator',
      'Metro is running at http://127.0.0.1:8081',
      'The app exposes a React Native CDP target through Metro',
      'Symptom: JavaScript heap may grow after filtering the product list',
      'Need only a compact first-pass JS heap growth signal before deciding whether to capture heap snapshots',
      'This is not a native/process memory investigation',
    ],
    task: 'Plan the CDP commands to select the Metro target and collect compact before/after JavaScript heap usage samples with GC, then diff the usage samples.',
    outputs: [
      plannedCommand('cdp target list'),
      /--url\s+http:\/\/127\.0\.0\.1:8081/i,
      plannedCommand('cdp target select'),
      CDP_MEMORY_USAGE_SAMPLE,
      /--label\s+baseline/i,
      /--label\s+after-action/i,
      plannedCommand('cdp memory usage diff'),
    ],
    forbiddenOutputs: [
      plannedCommand('perf memory sample'),
      plannedCommand('perf memory snapshot'),
      CDP_MEMORY_SNAPSHOT_CAPTURE,
      plannedCommand('react-devtools'),
    ],
  }),
  makeCase({
    id: 'react-native-native-memory-uses-perf-not-cdp',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android emulator',
      'The app is already open',
      'Symptom: total process RSS/PSS grows while scrolling a native image gallery',
      'Need native/process memory evidence and an Android heap artifact if escalation is needed',
      'This is not a JavaScript heap or retained JS object investigation',
    ],
    task: 'Plan the memory diagnostics commands for this native/process memory issue without using CDP heap snapshots.',
    outputs: [
      plannedCommand('perf memory sample'),
      /--json/i,
      plannedCommand('perf memory snapshot'),
      /--kind\s+android-hprof/i,
      /--out\s+\S+\.hprof/i,
    ],
    forbiddenOutputs: [
      plannedCommand('cdp'),
      CDP_MEMORY_USAGE_SAMPLE,
      CDP_MEMORY_SNAPSHOT_CAPTURE,
      plannedCommand('react-devtools'),
    ],
  }),
  makeCase({
    id: 'perf-apple-xctrace-profile',
    contract: [
      'App name: Agent Device Tester',
      'Platform: iOS simulator',
      'The app is already open',
      'Need Apple native CPU profiling evidence as a .trace artifact and compact JSON report',
      'Do not use debug or React DevTools for this native profile',
    ],
    task: 'Plan commands to record an Apple xctrace Time Profiler CPU profile under perf, stop it, then generate the compact report.',
    outputs: [
      plannedCommand('perf cpu profile start'),
      /--kind\s+xctrace/i,
      /--template\s+"?Time Profiler"?/i,
      /--out\s+\S+\.trace/i,
      plannedCommand('perf cpu profile stop'),
      plannedCommand('perf cpu profile report'),
      /--out\s+\S+\.json/i,
    ],
    forbiddenOutputs: [plannedCommand('debug'), plannedCommand('react-devtools')],
  }),
  makeCase({
    id: 'perf-android-native-profiling',
    contract: [
      'App package: com.example.app',
      'Platform: Android emulator',
      'Need native CPU profile and system trace artifacts for PR evidence',
      'Collect lightweight perf metrics and focused frame health first',
      'Do not claim iOS native Simpleperf or Perfetto support',
    ],
    task: 'Plan commands to open the Android app, collect perf metrics and frames, then capture Android native Simpleperf CPU and Perfetto trace artifacts.',
    outputs: [
      plannedCommand('open'),
      plannedCommand('perf metrics'),
      plannedCommand('perf frames'),
      plannedCommand('perf cpu profile start'),
      /--kind\s+simpleperf/i,
      plannedCommand('perf cpu profile stop'),
      plannedCommand('perf cpu profile report'),
      plannedCommand('perf trace start'),
      /--kind\s+perfetto/i,
      plannedCommand('perf trace stop'),
      /--out/i,
    ],
    forbiddenOutputs: [/ios/i, plannedCommand('debug'), plannedCommand('react-devtools')],
  }),
  makeCase({
    id: 'react-devtools-profile-search',
    contract: [
      'App name: Agent Device Tester',
      'React Native DevTools can connect to the running app',
      'Interaction to profile: type in the Catalog search field',
      'Search field selector: id="catalog-search"',
      'Need slow components and rerender counts',
    ],
    task: 'Plan the commands to verify React DevTools is connected, profile the Catalog search interaction, then list slow components and rerenders.',
    outputs: [
      plannedCommandAlternatives(['react-devtools status', 'react-devtools start']),
      plannedCommand('react-devtools wait'),
      plannedCommand('react-devtools profile start'),
      /catalog-search/i,
      plannedCommand('react-devtools profile stop'),
      BOUNDED_PROFILE_SLOW,
      BOUNDED_PROFILE_RERENDERS,
    ],
    forbiddenOutputs: [
      plannedCommand('snapshot'),
      plannedCommand('perf'),
      BROAD_PROFILE_SLOW_LIMIT,
    ],
  }),
  makeCase({
    id: 'react-devtools-bounded-profile-survey',
    contract: [
      'App name: Agent Device Tester',
      'React Native DevTools is connected',
      'Interaction to profile: expand the checkout totals panel',
      'Totals panel selector: id="checkout-totals"',
      'Need a compact performance report with initial summary, slow components, rerender counts, and commit timing',
      'Do not over-fetch broad profile tables while looking for offenders',
    ],
    task: 'Plan a bounded first-pass React DevTools profile workflow for the checkout totals interaction.',
    outputs: [
      plannedCommand('react-devtools wait'),
      plannedCommand('react-devtools profile start'),
      /checkout-totals/i,
      plannedCommand('react-devtools profile stop'),
      BOUNDED_PROFILE_SLOW,
      BOUNDED_PROFILE_RERENDERS,
      BOUNDED_PROFILE_TIMELINE,
    ],
    forbiddenOutputs: [BROAD_PROFILE_SLOW_LIMIT],
  }),
  makeCase({
    id: 'react-devtools-exact-component-inspect',
    contract: [
      'App name: Agent Device Tester',
      'React Native DevTools is connected',
      'Need current props, state, and hooks for component SearchScreen',
      'Fuzzy component search returns noisy matches unless exact matching is used',
    ],
    task: 'Plan bounded React DevTools commands to find the exact SearchScreen component and inspect it.',
    outputs: [
      plannedCommand('react-devtools find'),
      /SearchScreen/i,
      /--exact/i,
      plannedCommand('react-devtools get component'),
    ],
    forbiddenOutputs: [plannedCommand('snapshot'), plannedCommand('perf')],
  }),
  makeCase({
    id: 'react-devtools-render-cause-report',
    contract: [
      'App name: Agent Device Tester',
      'React Native profile has already been stopped',
      'Rerender suspect from profile output: @c12',
      'Need render causes and changed props/state/hooks for that component',
    ],
    task: 'Plan the React DevTools command to inspect render causes for @c12.',
    outputs: [plannedCommand('react-devtools profile report'), /@c12/i],
    forbiddenOutputs: [
      plannedCommand('snapshot'),
      plannedCommand('perf'),
      plannedCommand('react-devtools profile slow'),
      plannedCommand('react-devtools profile rerenders'),
    ],
  }),
  makeCase({
    id: 'react-native-diagnostics-flow',
    contract: [
      'App name: Agent Device Tester',
      'Platform: Android',
      'Current screen: Settings tab',
      'Slow interaction: load diagnostics from the Settings screen',
      'Diagnostics trigger selector: id="load-diagnostics"',
      'Expected async result selector: id="diagnostics-error"',
      'The diagnostics request can take 5-10 seconds',
      'Need React component offenders and network evidence',
      'Open Agent Device Tester on Android and take snapshot -i before interacting',
    ],
    task: 'Plan commands for a focused React Native performance run around the Settings diagnostics load flow, including debug markers, async verification, slow/rerender output, and network headers.',
    outputs: [
      plannedCommand('open'),
      /snapshot -i/i,
      /logs (?:clear --restart|start)/i,
      /logs mark\b[^\n]*(?:before|start|begin)/i,
      plannedCommand('react-devtools status'),
      plannedCommand('react-devtools wait'),
      plannedCommand('react-devtools profile start'),
      /load-diagnostics/i,
      /wait\b[^\n]*(?:diagnostics-error|Diagnostics error)/i,
      /(?:5000|10000|12000|15000|20000)/i,
      /logs mark\b[^\n]*(?:after|end|verified|diagnostics|loaded)/i,
      plannedCommand('react-devtools profile stop'),
      BOUNDED_PROFILE_SLOW,
      BOUNDED_PROFILE_RERENDERS,
      /network dump\b[^\n]*(?:--include headers|\bheaders\b|\ball\b)/i,
    ],
    forbiddenOutputs: [
      RAW_COORDINATE_TARGET,
      /cat .*log/i,
      /alert wait/i,
      /agent-devtools/i,
      BROAD_PROFILE_SLOW_LIMIT,
    ],
  }),
  makeCase({
    id: 'gesture-swipe-carousel',
    contract: [
      'Platform: iOS simulator',
      'Current screen: onboarding carousel',
      'Need to advance and return across pages repeatedly',
      'Gesture should use a swipe series, not scroll',
      'Use one direct swipe command with --count and --pattern; do not use batch',
      'Swipe series are bounded to 200 repetitions, 10000ms pauses, and 60000ms scheduled time',
    ],
    task: 'Plan one direct gesture command to swipe horizontally across the carousel eight times with a 30ms pause and ping-pong pattern.',
    outputs: [
      plannedCommand('swipe'),
      /--count\s+8/i,
      /--pause-ms\s+30/i,
      /--pattern\s+ping-pong/i,
    ],
    forbiddenOutputs: [plannedCommand('scroll'), plannedCommand('batch'), RAW_COORDINATE_TARGET],
  }),
  makeCase({
    id: 'gesture-longpress-context-menu',
    contract: [
      'Platform: Android',
      'Current screen: Catalog tab',
      'Target center is x=300 y=500',
      'Need to open a native context menu with an 800ms long press',
    ],
    task: 'Plan the gesture command to long-press the target center for 800ms.',
    outputs: [plannedCommand('longpress'), /300\s+500\s+800/i],
    forbiddenOutputs: [/--duration-ms/i, /--hold-ms/i, plannedCommand('click')],
  }),
  makeCase({
    id: 'gesture-longpress-ref-context-menu',
    contract: [
      'Platform: iOS simulator',
      'Current screen: chat thread',
      'Target message current ref: @e42',
      'Need to open the reaction menu with an 800ms long press',
    ],
    task: 'Plan the gesture command to long-press the current message ref for 800ms.',
    outputs: [plannedCommand('longpress'), /@e42/i, /\b800\b/i],
    forbiddenOutputs: [
      /--duration-ms/i,
      /--hold-ms/i,
      plannedCommand('click'),
      RAW_COORDINATE_TARGET,
    ],
  }),
  makeCase({
    id: 'gesture-pinch-zoom',
    contract: [
      'Platform: iOS simulator',
      'Current screen: image preview',
      'Pinch is supported on Apple simulators',
      'Need to zoom out around x=200 y=400',
      'Zoom-out scale: 0.5',
    ],
    task: 'Plan the gesture command to pinch zoom out at the specified center.',
    outputs: [plannedCommand('gesture pinch'), /0\.5/i, /200\s+400/i],
    forbiddenOutputs: [
      /(?:^|\s)--scale(?!\w)/i,
      /(?:^|\s)--x(?!\w)/i,
      /(?:^|\s)--y(?!\w)/i,
      plannedCommand('scroll'),
      plannedCommand('swipe'),
    ],
  }),
  makeCase({
    id: 'gesture-pan-fling-rotate',
    contract: [
      'Platform: iOS simulator',
      'Current screen: gesture lab',
      'Target center is x=200 y=420',
      'The target point is app-owned content away from screen edges, tab bars, navigation bars, and home indicators',
      'Need to test a slow upward pan, a right fling, and app-content rotation',
      'Pan delta is dx=0 dy=-80 over 500ms',
      'Fling distance is 180px',
      'Rotation is 35 degrees',
    ],
    task: 'Plan direct agent-device gesture commands for the pan, fling, and rotate gesture.',
    outputs: [
      plannedCommand('gesture pan'),
      /200\s+420\s+0\s+-80\s+500/i,
      plannedCommand('gesture fling'),
      /right\s+200\s+420\s+180/i,
      plannedCommand('gesture rotate'),
      /35\s+200\s+420/i,
    ],
    forbiddenOutputs: [
      plannedCommand('swipe'),
      topLevelPlannedCommand('pan'),
      topLevelPlannedCommand('fling'),
      topLevelPlannedCommand('rotate'),
      topLevelPlannedCommand('rotate-gesture'),
      /--duration-ms/i,
      /--pointer-count/i,
    ],
  }),
  makeCase({
    id: 'gesture-two-finger-pan',
    contract: [
      'Platform: Android',
      'Current screen: map tilt canary',
      'Target center is x=200 y=420',
      'The recognizer requires exactly two fingers moving in parallel',
      'Pan delta is dx=80 dy=-40 over 700ms',
      'Do not add scale or rotation',
    ],
    task: 'Plan the direct agent-device gesture command for the two-finger pan.',
    outputs: [plannedCommand('gesture pan'), /200\s+420\s+80\s+-40\s+700/i, /--pointer-count\s+2/i],
    forbiddenOutputs: [
      plannedCommand('gesture transform'),
      plannedCommand('gesture pinch'),
      plannedCommand('gesture rotate'),
      /(?:^|\s)--count(?:\s|=)/i,
    ],
  }),
  makeCase({
    id: 'android-gesture-transform',
    contract: [
      'Platform: Android',
      'Current screen: gesture lab',
      'Target center is x=200 y=420',
      'Need the direct transform command rather than separate gesture commands',
      'Pan delta is dx=80 dy=-40',
      'Zoom scale is 2',
      'Rotation is 35 degrees',
      'Duration is 700ms',
      'After the command, verify Android changed qualitatively instead of asserting exact x, y, scale, or rotate values',
    ],
    task: 'Plan the direct agent-device command for the combined pan, zoom, and rotate gesture, then verify qualitative state.',
    outputs: [
      plannedCommand('gesture transform'),
      /200\s+420\s+80\s+-40\s+2\s+35\s+700/i,
      plannedCommand('wait'),
      /pan changed yes/i,
      /pinch changed yes/i,
      /rotate changed yes/i,
    ],
    forbiddenOutputs: [
      plannedCommand('gesture pan'),
      plannedCommand('gesture pinch'),
      plannedCommand('gesture rotate'),
      plannedCommand('compose-gestures'),
      /wait\s+["']?x\s/i,
      /wait\s+["']?scale\s/i,
      /wait\s+["']?rotate\s+\d/i,
    ],
  }),
  makeCase({
    id: 'ios-simulator-gesture-transform',
    contract: [
      'Platform: iOS simulator',
      'Current screen: gesture lab',
      'Target center is x=200 y=420',
      'Need one continuous two-finger gesture without lifting fingers',
      'Pan delta is dx=80 dy=-40',
      'Zoom scale is 2',
      'Rotation is 35 degrees',
      'Duration is 700ms',
    ],
    task: 'Plan the direct agent-device command for the combined pan, zoom, and rotate gesture.',
    outputs: [plannedCommand('gesture transform'), /200\s+420\s+80\s+-40\s+2\s+35\s+700/i],
    forbiddenOutputs: [
      plannedCommand('gesture pan'),
      plannedCommand('gesture pinch'),
      plannedCommand('gesture rotate'),
      plannedCommand('rotate-gesture'),
      plannedCommand('swipe'),
    ],
  }),
  makeCase({
    id: 'settings-animation-stabilizer',
    contract: [
      'Platform: Android',
      'App name: Agent Device Tester',
      'Animations make this flow flaky',
      'Animations should be restored after the check',
    ],
    task: 'Plan the commands to disable platform animations before the app check, run a snapshot, then restore animations.',
    outputs: [/settings animations off/i, plannedCommand('snapshot'), /settings animations on/i],
    forbiddenOutputs: [
      /--platform macos/i,
      /settings appearance/i,
      /animations disable/i,
      /animations restore/i,
    ],
  }),
  makeCase({
    id: 'trace-capture-session',
    contract: [
      'App name: Agent Device Tester',
      'An app session is already open',
      'Repro button selector: id="load-diagnostics"',
      'Need low-level session diagnostics for one diagnostics-button repro',
      'Trace artifact path: ./traces/diagnostics.trace',
    ],
    task: 'Plan the commands to start trace capture, trigger diagnostics, then stop the trace into the requested artifact path.',
    outputs: [
      /trace start \.\/traces\/diagnostics\.trace/i,
      /load-diagnostics/i,
      /trace stop \.\/traces\/diagnostics\.trace/i,
    ],
    forbiddenOutputs: [
      plannedCommand('record'),
      /logs clear --restart/i,
      /trace (?:start|stop) --path/i,
    ],
  }),
  makeCase({
    id: 'alert-visible-ui-fallback',
    contract: [
      'App name: Agent Device Tester',
      'Current screen: Home tab',
      'A visible permission sheet contains the button text "Allow"',
      'alert accept already returned no alert found',
    ],
    task: 'Plan the fallback commands to handle the visible sheet as normal tappable UI instead of looping on alert accept.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?(?:find\b.*\bpress\b|(?:press|click)\b.*Allow|snapshot -i)/is,
      /Allow/i,
    ],
    forbiddenOutputs: [/alert accept.*\n.*alert accept/is, RAW_COORDINATE_TARGET],
  }),
  makeCase({
    id: 'android-keyboard-readonly-status',
    contract: [
      'Platform: Android',
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'Question: is the keyboard visible and what input type is active?',
    ],
    task: 'Plan the read-only command to inspect Android keyboard visibility and input type.',
    outputs: [/(?:^|\n)(?:agent-device\s+)?keyboard(?:\s+(?:status|get))?(?:\s|$)/i],
    forbiddenOutputs: [plannedCommand('fill'), plannedCommand('type'), /keyboard dismiss/i],
  }),
  makeCase({
    id: 'android-fill-ime-capture-stop-retry-loop',
    contract: [
      'Platform: Android',
      'App name: Agent Device Tester',
      'Current screen: Checkout form tab',
      'The Android IME capture fixture is visible: id="android-ime-capture-fixture"',
      'The app field is still visible as targetInput id="field-ime-capture-target"',
      'The last fill failed: Android fill input was captured by the active keyboard instead of the app field',
      'Diagnostic details show actualInput packageName="com.google.android.inputmethod.latin" inputMethodOwned=true',
    ],
    task: 'Plan the next diagnostic step. Do not retry fill or type until the IME handwriting/stylus state has been corrected.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?keyboard(?:\s+(?:status|get))?(?:\s|$)/i,
      /(?:IME|keyboard|Gboard|handwriting|stylus)/i,
    ],
    forbiddenOutputs: [
      plannedCommand('fill'),
      plannedCommand('type'),
      RAW_COORDINATE_TARGET,
      /adb shell/i,
    ],
  }),
  makeCase({
    id: 'direct-proxy-remote-simulator-flow',
    contract: [
      'The agent is running in a cloud Linux environment',
      'The user says a remote iOS simulator is available through agent-device proxy',
      'Proxy daemon base URL: https://example.trycloudflare.com/agent-device',
      'Proxy daemon auth token: proxy-secret',
      'Platform: iOS',
      'Device: iPhone 17 Pro',
      'App: Maps',
      'This is direct proxy mode, not cloud/profile mode',
      'Use one explicit session for the whole flow: maps',
    ],
    task: 'Plan commands to open Maps on the remote simulator through the direct proxy, capture interactive refs, and close the session.',
    outputs: [
      /open\s+Maps\b/i,
      /snapshot\b[^\n]*-i\b/i,
      /close\b/i,
      /--session maps/i,
      /--platform ios/i,
      /--device ["']iPhone 17 Pro["']/i,
      /--daemon-base-url https:\/\/example\.trycloudflare\.com\/agent-device/i,
      /--daemon-auth-token proxy-secret/i,
    ],
    forbiddenOutputs: [
      plannedCommand('connect'),
      plannedCommand('disconnect'),
      /--remote-config/i,
      /--tenant/i,
      /--run-id/i,
      /--lease-id/i,
    ],
  }),
  makeCase({
    id: 'remote-cloud-connect-flow',
    contract: [
      'Cloud control plane owns the connection profile',
      'No local remote config path was provided',
      'App package: com.callstack.agentdevicetester',
      'The cloud profile owns tenant, run, lease, and Metro hints',
    ],
    task: 'Plan a remote flow that discovers the cloud connection profile, opens the app, captures a snapshot, and disconnects cleanly.',
    outputs: [
      plannedCommand('connect'),
      plannedCommand('open'),
      plannedCommand('snapshot'),
      plannedCommand('disconnect'),
    ],
    forbiddenOutputs: [
      /--remote-config/i,
      /--daemon-base-url/i,
      /--tenant/i,
      /--run-id/i,
      plannedCommand('screenshot'),
    ],
  }),
  makeCase({
    id: 'remote-config-connect-flow',
    contract: [
      'Remote config path: ./remote-config.json',
      'App package: com.callstack.agentdevicetester',
      'The remote profile owns tenant, run, lease, and Metro hints',
    ],
    task: 'Plan a remote flow that connects through the remote config, opens the app, captures a snapshot, and disconnects cleanly.',
    outputs: [
      /connect --remote-config \.\/remote-config\.json/i,
      plannedCommand('open'),
      plannedCommand('snapshot'),
      plannedCommand('disconnect'),
    ],
    forbiddenOutputs: [
      /--daemon-base-url/i,
      /--tenant/i,
      /--run-id/i,
      plannedCommand('screenshot'),
    ],
  }),
  makeCase({
    id: 'remote-config-script-flow',
    contract: [
      'Remote config path: ./remote-config.json',
      'App package: com.callstack.agentdevicetester',
      'This is a self-contained script where every command must be explicit',
      'The remote profile owns tenant, run, lease, and Metro hints',
    ],
    task: 'Plan a self-contained remote script that opens the app, captures a snapshot, and disconnects using the remote config on every command.',
    outputs: [
      /(?:--remote-config\s+\.\/remote-config\.json[^\n]*open|open\b[^\n]*--remote-config\s+\.\/remote-config\.json)/i,
      /(?:--remote-config\s+\.\/remote-config\.json[^\n]*snapshot|snapshot\b[^\n]*--remote-config\s+\.\/remote-config\.json)/i,
      /(?:--remote-config\s+\.\/remote-config\.json[^\n]*disconnect|disconnect\b[^\n]*--remote-config\s+\.\/remote-config\.json)/i,
    ],
    forbiddenOutputs: [/--daemon-base-url/i, /--tenant/i, /--run-id/i],
  }),
  makeCase({
    id: 'remote-ios-runner-lease-retry-snapshot',
    contract: [
      'Direct proxy flow to a remote Mac is already configured',
      'Platform: iOS',
      'Device: iPhone 17 Pro',
      'The remote agent already opened Maps successfully',
      'The first interactive snapshot failed: iOS runner is already owned by another agent-device daemon',
      'The proxy daemon can reclaim stale same-state runner leases on retry',
    ],
    task: 'Plan the next remote client command. Do not run prepare ios-runner or prescribe host process cleanup; retry the original interactive snapshot.',
    outputs: [/snapshot\b[^\n]*-i\b/i, /--platform ios/i, /--device ["']iPhone 17 Pro["']/i],
    forbiddenOutputs: [
      plannedCommand('prepare ios-runner'),
      /prepare\s+ios-runner/i,
      plannedCommand('open'),
      /\bkill\b/i,
      /clean:daemon/i,
    ],
  }),
  makeCase({
    id: 'macos-menubar-surface',
    contract: [
      'Platform: macOS',
      'App name: Agent Device Tester Menu',
      'The app lives entirely as a menu bar extra',
      'Normal app snapshots can be sparse or empty',
      'Required flags: --platform macos --surface menubar',
    ],
    task: 'Plan the commands to inspect the menu bar app surface with --platform macos --surface menubar and capture interactive refs with snapshot -i.',
    outputs: [/--platform macos/i, /--surface menubar/i, /snapshot\b.*(?:-i\b|\s-i\b)/i],
    forbiddenOutputs: [/--surface app/i, /snapshot --raw/i],
  }),
  makeCase({
    id: 'macos-context-menu-secondary-click',
    contract: [
      'Platform: macOS',
      'Current surface: app',
      'Target row current ref: @e66',
      'Need to open its native context menu and inspect menu item refs',
      'Required platform flag: --platform macos',
    ],
    task: 'Plan commands with --platform macos to open the context menu for @e66 and then refresh interactive refs for the menu items.',
    outputs: [
      plannedCommand('click'),
      /@e66/i,
      /--button\s+secondary/i,
      /--platform\s+macos/i,
      /snapshot\b.*-i/i,
    ],
    forbiddenOutputs: [plannedCommand('longpress'), RAW_COORDINATE_TARGET, /--surface menubar/i],
  }),
  makeCase({
    id: 'replay-maintenance-update',
    contract: [
      'Replay path: ./replays/catalog-checkout.ad',
      'Selectors drifted after a UI label change',
      '--update is accepted but retired: it never rewrites the replay file and reports healed: 0',
      'The divergence reports resume.from=4 and resume.planDigest=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'Workflow A: after accepting a suggestion and editing the script, the old digest is stale; run a fresh full replay with no resume flags',
      'Workflow B: when the script and includes stay unchanged, repair app state so retrying the failed action is safe, then resume with the reported values',
      'Output exactly the two alternative replay commands in A-then-B order; manual edits and app-state repairs happen out of band',
    ],
    task: 'Plan both valid replay-maintenance commands after selector drift.',
    outputs: [
      /(?:^|\n)agent-device\s+replay\s+\.\/replays\/catalog-checkout\.ad\s*(?:\n|$)/i,
      /(?:^|\n)agent-device\s+replay\s+\.\/replays\/catalog-checkout\.ad(?=[^\n]*--from\s+4\b)(?=[^\n]*--plan-digest\s+0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\b)[^\n]*(?:\n|$)/i,
    ],
    forbiddenOutputs: [
      /(?:^|\n)agent-device\s+replay\s+\.\/replays\/catalog-checkout\.ad[^\n]*(?:-u\b|--update\b)/i,
      /(?:^|\n)agent-device\s+replay\s+\.\/replays\/catalog-checkout\.ad(?=[^\n]*--from\b)(?![^\n]*--plan-digest\b)[^\n]*/i,
      /(?:^|\n)agent-device\s+replay\s+\.\/replays\/catalog-checkout\.ad(?=[^\n]*--plan-digest\b)(?![^\n]*--from\b)[^\n]*/i,
    ],
  }),
  makeCase({
    id: 'replay-maestro-compatibility-flow',
    contract: [
      'Flow path: ./flows/checkout-form.yaml',
      'The flow is a Maestro YAML compatibility flow',
      'Need to run it through Agent Device replay, not the Maestro CLI',
      'Target platform: iOS',
    ],
    task: 'Plan the command to replay the Maestro YAML flow through Agent Device on iOS.',
    outputs: [
      plannedCommand('replay'),
      /--maestro/i,
      /\.\/flows\/checkout-form\.yaml/i,
      /--platform\s+ios/i,
    ],
    forbiddenOutputs: [/maestro\s+test/i, /maestro\s+cloud/i, plannedCommand('test')],
  }),
  makeCase({
    id: 'test-maestro-shard-all-devices',
    contract: [
      'Suite path: ./e2e/maestro',
      'The suite contains Maestro YAML compatibility flows',
      'Connected device ids: udid1, emulator-5554',
      'Need local cross-device validation by running the full suite on each device',
    ],
    task: 'Plan the Agent Device test command that runs the Maestro suite on both connected devices without calling the Maestro CLI directly.',
    outputs: [
      plannedCommand('test'),
      /--maestro/i,
      /--device\s+["']?udid1,emulator-5554["']?/i,
      /--shard-all\s+2/i,
      /\.\/e2e\/maestro/i,
    ],
    forbiddenOutputs: [/maestro\s+test/i, /--shard-split/i, /--platform\s+(?:ios|android)/i],
  }),
  makeCase({
    id: 'batch-known-stable-flow',
    contract: [
      'App name: Agent Device Tester',
      'The full checkout flow is already known and stable',
      'Known batch steps file: ./checkout-steps.json',
      'Need fewer round trips while recording evidence',
    ],
    task: 'Plan the commands to start a recording, execute the known checkout steps from the provided steps file as one batch, and stop the recording.',
    outputs: [
      /(?:^|\n)(?:agent-device\s+)?record\s+start/i,
      plannedCommand('batch'),
      /(?:^|\n)(?:agent-device\s+)?record\s+stop/i,
    ],
    forbiddenOutputs: [PSEUDO_ASSERTION_COMMAND, /workflow batch/i, plannedCommand('trace')],
  }),
  makeCase({
    id: 'same-session-mutations-serial',
    contract: [
      'Session: dogfood-test-app',
      'Current screen: Checkout form tab',
      'Name field selector: id="field-name"',
      'Email field selector: id="field-email"',
      'Submit button selector: id="submit-order"',
      'Need to fill name, fill email, and press submit as three separate commands',
      'All commands mutate the same active device session',
      'Parallel same-session mutations can pollute focus and field state',
      'Do not use batch for this case; demonstrate serial command ordering',
    ],
    task: 'Plan the three separate serial commands for this same-session form flow using the durable selectors.',
    outputs: [/--session dogfood-test-app/i, /field-name/i, /field-email/i, /submit-order/i],
    forbiddenOutputs: [
      /Based on my/i,
      /Let me/i,
      /Promise\.all/i,
      /(?:^|\n).*(?:fill|press).*(?:&|&&).*(?:fill|press)/i,
      /parallel/i,
      plannedCommand('batch'),
    ],
  }),
  makeCase({
    id: 'batch-inline-step-schema-input',
    contract: [
      'Need one inline batch command',
      'Step 1: open settings',
      'Step 2: wait 100 ms',
      'Batch step schema supports command, input, and runtime',
      'The args field is invalid and must not be used',
    ],
    task: 'Plan the batch command with inline JSON steps using the supported structured input field.',
    outputs: [plannedCommand('batch'), /--steps/i, /"input"\s*:/i, /"open"/i, /"wait"/i],
    forbiddenOutputs: [/"args"\s*:/i, /"positionals"\s*:/i, /workflow batch/i],
  }),
];

const suite: Case[] = [
  ...withTags(['fixture-smoke'], FIXTURE_SMOKE_CASES),
  ...withTags(['skill-guidance'], SKILL_GUIDANCE_CASES),
];

export default suite;
