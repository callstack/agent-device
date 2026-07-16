import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_COMMANDS } from '../src/command-catalog.ts';
import { listCommandMetadata } from '../src/commands/command-metadata.ts';
import { getFlagDefinitions } from '../src/commands/cli-grammar/flag-registry.ts';

const EMPTY_COVERAGE_METRIC = { pct: 0 };
const EMPTY_STATEMENT_COVERAGE = { covered: 0, pct: 0, total: 0 };

export function buildIntegrationProgressModel({ root = process.cwd() } = {}) {
  const coverageSummary = path.join(root, 'coverage/coverage-summary.json');
  const handlerTestDir = path.join(root, 'src/daemon/handlers/__tests__');
  const providerScenarioDir = path.join(root, 'test/integration/provider-scenarios');
  const commandContractFiles = listFiles(path.join(root, 'src/commands'), (file) =>
    isCommandContractSource(file),
  );
  const clientCommandMethods = readClientCommandMethods(commandContractFiles);

  const handlerTests = listFiles(handlerTestDir, (file) => file.endsWith('.test.ts'));
  const providerScenarioTests = listFiles(providerScenarioDir, (file) => file.endsWith('.test.ts'));
  const providerScenarioSources = listFiles(providerScenarioDir, (file) => file.endsWith('.ts'));
  const providerScenarioSupportSources = providerScenarioSources.filter(
    (file) => !file.endsWith('.test.ts'),
  );
  const handlerStats = summarizeFiles(handlerTests);
  const providerScenarioStats = summarizeFiles(providerScenarioTests);
  const providerScenarioSupportStats = summarizeFiles(providerScenarioSupportSources);
  const mockHeavyHandlerFiles = handlerTests.filter((file) =>
    fs.readFileSync(file, 'utf8').includes('vi.mock('),
  );
  const mockHeavyHandlerRows = summarizeMockHeavyHandlerFiles(root, mockHeavyHandlerFiles);
  const providerPressureRows = summarizeProviderPressure(providerScenarioSources);
  const publicCommandRows = summarizePublicCommandCoverage(
    providerScenarioTests,
    clientCommandMethods,
  );
  const missingPublicCommands = publicCommandRows.filter((command) => command.references === 0);
  const flagCoverageRows = summarizeProviderScenarioFlagCoverage(providerScenarioTests);
  const missingFlagRows = flagCoverageRows.filter((flag) => flag.references === 0);
  const excludedFlagRows = summarizeProviderScenarioFlagExclusions();
  const publicCliFlagKeys = readPublicCliFlagKeys();
  const classifiedFlagKeys = new Set([
    ...flagCoverageRows.map((flag) => flag.key),
    ...excludedFlagRows.flatMap((group) => group.keys),
  ]);
  const unclassifiedFlagKeys = [...publicCliFlagKeys].filter((key) => !classifiedFlagKeys.has(key));
  const coverage = readCoverageSummary(coverageSummary);
  const lowCoverageFiles = readLowCoverageFiles(root, coverageSummary);

  const summaryRows = [
    ['Handler unit test files', String(handlerStats.files)],
    ['Handler unit test LOC', String(handlerStats.lines)],
    ['Handler unit tests', String(handlerStats.tests)],
    ['Handler files with vi.mock', String(mockHeavyHandlerFiles.length)],
    ['Provider scenario files', String(providerScenarioStats.files)],
    ['Provider scenario LOC', String(providerScenarioStats.lines)],
    ['Provider scenario tests', String(providerScenarioStats.tests)],
    ['Provider scenario support files', String(providerScenarioSupportStats.files)],
    ['Provider scenario support LOC', String(providerScenarioSupportStats.lines)],
    ['Provider scenario / handler LOC', ratio(providerScenarioStats.lines, handlerStats.lines)],
    [
      'Public commands covered by provider-backed integration',
      `${publicCommandRows.length - missingPublicCommands.length}/${publicCommandRows.length}`,
    ],
    [
      'Public commands missing provider-backed integration coverage',
      String(missingPublicCommands.length),
    ],
    [
      'Device-observable workflow flags covered by provider-backed integration',
      `${flagCoverageRows.length - missingFlagRows.length}/${flagCoverageRows.length}`,
    ],
    [
      'Device-observable workflow flags missing provider-backed integration coverage',
      String(missingFlagRows.length),
    ],
    [
      'Public CLI flags intentionally outside provider-backed integration',
      String(excludedFlagRows.reduce((sum, group) => sum + group.keys.length, 0)),
    ],
    ['Public CLI flags unclassified by progress script', String(unclassifiedFlagKeys.length)],
  ];

  if (coverage) {
    summaryRows.push(
      ['Coverage statements', formatPercent(coverage.statements)],
      ['Coverage branches', formatPercent(coverage.branches)],
      ['Coverage functions', formatPercent(coverage.functions)],
      ['Coverage lines', formatPercent(coverage.lines)],
    );
  } else {
    summaryRows.push(['Coverage summary', 'not available; run pnpm test:coverage first']);
  }

  return {
    coverage,
    excludedFlagRows,
    flagCoverageRows,
    lowCoverageFiles,
    missingFlagRows,
    missingPublicCommands,
    mockHeavyHandlerRows,
    providerPressureRows,
    publicCommandRows,
    summaryRows,
    unclassifiedFlagKeys,
  };
}

export function buildIntegrationProgressFailures(progress) {
  const failures = [];
  if (progress.missingPublicCommands.length > 0) {
    failures.push(
      `missing Provider-backed integration command coverage: ${progress.missingPublicCommands.map((row) => row.command).join(', ')}`,
    );
  }
  if (progress.missingFlagRows.length > 0) {
    failures.push(
      `missing Provider-backed integration workflow flag coverage: ${progress.missingFlagRows.map((row) => row.key).join(', ')}`,
    );
  }
  if (progress.unclassifiedFlagKeys.length > 0) {
    failures.push(`unclassified public CLI flags: ${progress.unclassifiedFlagKeys.join(', ')}`);
  }
  return failures;
}

function summarizeProviderScenarioFlagCoverage(files) {
  const flagTargets = [
    ['platform', 'selection across platform-specific provider-backed integration flows'],
    ['target', 'target-class routing such as tv/mobile/desktop'],
    ['device', 'human-readable device selection'],
    ['udid', 'Apple device selection'],
    ['serial', 'Android device selection'],
    ['iosSimulatorDeviceSet', 'iOS simulator-set scoping reaches inventory resolution'],
    ['androidDeviceAllowlist', 'Android serial allowlist reaches inventory resolution'],
    ['session', 'named session routing'],
    ['targetApp', 'doctor target app discovery without opening a session'],
    ['surface', 'macOS app/frontmost/desktop/menubar surfaces'],
    ['activity', 'Android explicit launch activity'],
    ['launchConsole', 'iOS simulator launch console capture'],
    ['saveScript', 'open/close replay recording output'],
    ['relaunch', 'open terminates before launch'],
    ['shutdown', 'close/disconnect shutdown behavior'],
    ['appsFilter', 'apps --all vs default filtering'],
    ['header', 'install-from-source URL headers', ['headers']],
    ['retainPaths', 'retained install-source materialization'],
    ['retentionMs', 'install-source materialization TTL'],
    ['count', 'repeated press/click/swipe input'],
    ['pointerCount', 'one- vs two-pointer pan gesture topology'],
    ['fps', 'recording frame-rate request'],
    ['quality', 'recording quality scaling'],
    ['hideTouches', 'recording without touch overlays'],
    ['recordingScope', 'recording app vs whole-screen scope', ['scope']],
    ['intervalMs', 'repeated press interval'],
    ['delayMs', 'typing/fill delay'],
    ['durationMs', 'scroll, gesture, and TV remote duration'],
    ['holdMs', 'press hold duration'],
    ['jitterPx', 'press jitter'],
    ['pixels', 'scroll distance'],
    ['doubleTap', 'double tap gesture'],
    ['clickButton', 'desktop mouse button selection', ['button']],
    ['backMode', 'explicit app/system back behavior', ['mode']],
    ['pauseMs', 'swipe repeat pause'],
    ['pattern', 'swipe repeat pattern'],
    ['snapshotInteractiveOnly', 'interactive snapshot/ref refresh', ['interactiveOnly']],
    ['snapshotDepth', 'scoped snapshot depth', ['depth']],
    ['snapshotScope', 'scoped snapshot capture', ['scope']],
    ['snapshotRaw', 'raw snapshot node output', ['raw']],
    ['out', 'artifact output path plumbing'],
    ['overlayRefs', 'screenshot ref overlay annotation'],
    ['screenshotFullscreen', 'screenshot full-screen capture mode'],
    ['screenshotMaxSize', 'screenshot max-size post-processing'],
    ['screenshotNoStabilize', 'screenshot stabilization opt-out', ['stabilize']],
    ['restart', 'logs clear --restart workflow'],
    ['networkInclude', 'network dump include modes', ['include']],
    ['noRecord', 'action recording suppression'],
    ['record', 'repair-segment observation-only recording opt-in (ADR 0012)'],
    ['replayUpdate', 'retired --update no-op replays without rewriting (ADR 0012)', ['update']],
    ['replayEnv', 'replay/test variable injection', ['env']],
    ['replayFrom', 'replay resume skips completed steps (ADR 0012)', ['resumeFrom']],
    ['replayPlanDigest', 'replay resume plan-digest preflight binding', ['resumePlanDigest']],
    ['failFast', 'test suite stops after first failure'],
    ['timeoutMs', 'wait/test timeout flags'],
    ['retries', 'test suite retry budget flows through request path'],
    ['artifactsDir', 'test artifact root'],
    ['steps', 'batch inline steps'],
    ['batchOnError', 'batch stop-on-error policy', ['onError']],
    ['batchMaxSteps', 'batch max-step guard', ['maxSteps']],
    ['findFirst', 'find first disambiguation'],
    ['findLast', 'find last disambiguation'],
    ['verify', 'descriptor post-action evidence capture'],
    ['settle', 'descriptor post-action settled-diff observation'],
    ['settleQuietMs', 'settle quiet-window tuning'],
  ];
  const sources = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  return flagTargets.map(([key, reason, aliases = []]) => {
    const references = [key, ...aliases].reduce(
      (count, candidate) => count + countFlagReferences(sources, candidate),
      0,
    );
    return { key, reason, references };
  });
}

function countFlagReferences(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`\\b${escaped}\\s*:`, 'g'))?.length ?? 0;
}

function summarizeProviderScenarioFlagExclusions() {
  return [
    {
      name: 'config, output, diagnostics, and transport',
      owner: 'args/CLI transport/auth tests',
      keys: [
        'config',
        'remoteConfig',
        'stateDir',
        'daemonBaseUrl',
        'daemonAuthToken',
        'daemonTransport',
        'daemonServerMode',
        'remote',
        'tenant',
        'sessionIsolation',
        'runId',
        'leaseId',
        'leaseBackend',
        'json',
        'help',
        'version',
        'verbose',
        'cost',
        'responseLevel',
      ],
    },
    {
      name: 'remote connection and session-lock policy',
      owner: 'connection/runtime/request policy tests',
      keys: ['force', 'noLogin', 'sessionLock', 'sessionLocked', 'sessionLockConflicts'],
    },
    {
      name: 'cloud artifact provider lookup',
      owner:
        'cloud provider profile, artifact provider, CLI output, and cloud WebDriver provider scenario tests',
      keys: [
        'provider',
        'providerSessionId',
        'providerApp',
        'providerOsVersion',
        'providerProject',
        'providerBuild',
        'providerSessionName',
        'awsProjectArn',
        'awsDeviceArn',
        'awsAppArn',
        'awsRegion',
        'awsInteractionMode',
      ],
    },
    {
      name: 'Metro and React Native runtime preparation',
      owner: 'Metro companion integration and parser tests',
      keys: [
        'metroHost',
        'metroPort',
        'metroProjectRoot',
        'metroKind',
        'metroPublicBaseUrl',
        'metroProxyBaseUrl',
        'metroBearerToken',
        'metroPreparePort',
        'metroListenHost',
        'metroStatusHost',
        'metroStartupTimeoutMs',
        'metroProbeTimeoutMs',
        'metroRuntimeFile',
        'metroNoReuseExisting',
        'metroNoInstallDeps',
        'bundleUrl',
        'launchUrl',
      ],
    },
    {
      name: 'Apple launch and perf artifact options',
      owner: 'iOS platform, observability command, and parser tests',
      keys: [
        'deviceHub',
        'kind',
        'launchArgs',
        'perfTemplate',
        'iosXctestrunFile',
        'iosXctestDerivedDataPath',
        'iosXctestEnvDir',
      ],
    },
    {
      name: 'parser/client-only command flags',
      owner: 'args, CLI, debug-symbols, screenshot-diff, and batch tests',
      keys: [
        'artifact',
        'dsym',
        'githubActionsArtifact',
        'snapshotDiff',
        'snapshotForceFull',
        'baseline',
        'threshold',
        'reporter',
        'reportJunit',
        'replayMaestro',
        'replayExportFormat',
        'recordVideo',
        'shardAll',
        'shardSplit',
        'searchPath',
        'stepsFile',
        'proxyHost',
        'proxyPort',
      ],
    },
    {
      name: 'platform boot fallback without provider seam',
      owner: 'handler and Android platform unit tests',
      keys: ['headless', 'testIme'],
    },
    {
      name: 'Apple simulator screenshot rendering options',
      owner: 'iOS platform and screenshot-diff runtime tests',
      keys: ['screenshotNormalizeStatusBar', 'screenshotPixelDensity'],
    },
  ];
}

function readPublicCliFlagKeys() {
  return new Set(
    getFlagDefinitions()
      .filter((definition) => definition.names.some((name) => name.startsWith('-')))
      .map((definition) => definition.key),
  );
}

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, predicate);
    return predicate(fullPath) ? [fullPath] : [];
  });
}

function isCommandContractSource(file) {
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.test.ts') &&
    !file.includes(`${path.sep}__tests__${path.sep}`)
  );
}

function summarizeFiles(files) {
  let lines = 0;
  let tests = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    lines += text.split('\n').length;
    tests += countTestDeclarations(text);
  }
  return { files: files.length, lines, tests };
}

function summarizeMockHeavyHandlerFiles(root, files) {
  return files
    .map((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return {
        file: path.relative(root, file),
        lines: text.split('\n').length,
        tests: countTestDeclarations(text),
      };
    })
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 12);
}

function summarizeProviderPressure(files) {
  const surfaces = [
    {
      name: 'Android ADB provider',
      pattern:
        /\bAndroidAdbProvider\b|\bandroidAdbProvider\b|\badbProvider\b|\badb\.(?:exec|installer|puller|portReverse)\b/g,
    },
    {
      name: 'Apple runner provider',
      pattern: /\bAppleRunnerProvider\b|\bappleRunnerProvider\b|\b(?:ios|macos|tvos)\.runner\b/g,
    },
    {
      name: 'Apple simctl/devicectl provider',
      pattern: /\bsimctl\b|\bdevicectl\b|\brunXcrun\b|\bsimctl\s*:|\bdevicectl\s*:/g,
    },
    {
      name: 'Apple macOS helper provider',
      pattern: /\bmacos-helper\b|\bagent-device-macos-helper\b|\bmacosHelper\s*:/g,
    },
    {
      name: 'Apple macOS host provider',
      pattern:
        /\bmacos-host\b|\bmacosHost\s*:|\bAppleMacOsHostProvider\b|\bopenBundle\b|\bopenTarget\b|\breadClipboard\b|\bwriteClipboard\b|\breadDarkMode\b|\bsetDarkMode\b|\blistApps\b/g,
    },
    {
      name: 'Apple generic host-tool provider',
      pattern: buildAppleGenericHostToolPattern(),
    },
    {
      name: 'Linux semantic desktop provider',
      pattern: /\bdesktop\b|\bopenTarget\b|\bcloseApp\b/g,
    },
    {
      name: 'Linux semantic accessibility/clipboard/screenshot provider',
      pattern:
        /\baccessibility\b|\bcaptureTree\b|\bclipboard\b|\breadText\b|\bwriteText\b|\bscreenshot\b|\bcapture\s*:/g,
    },
    {
      name: 'Linux semantic input provider',
      pattern: /\bLinuxInputProvider\b|\bprovider\.input\b|\binput\s*:|\['input'/g,
    },
    {
      name: 'Linux generic tool provider',
      pattern:
        /\bLinuxToolProvider\b|\blinuxToolProvider\b|\brunCommand\b|\bwhichCommand\b|\bxdotool\b|\bydotool\b|\bxclip\b|\bscrot\b|\bgrim\b|\bwmctrl\b|\bpkill\b/g,
    },
    {
      name: 'Web semantic provider',
      pattern:
        /\bWebProvider\b|\bwebProvider\b|\bwithWebProvider\b|\bresolveWebProvider\b|\['web'/g,
    },
    {
      name: 'Recording provider',
      pattern: /\bRecordingProvider\b|\brecordingProvider\b|\bstartRecording\b/g,
    },
  ];

  return surfaces
    .map((surface) => ({ name: surface.name, ...countSurfaceReferences(files, surface.pattern) }))
    .filter((surface) => surface.references > 0);
}

function buildAppleGenericHostToolPattern(): RegExp {
  const hostTools = [
    'xcrun',
    'open',
    'pbcopy',
    'pbpaste',
    'plutil',
    'osascript',
    'swift',
    'codesign',
    'mdfind',
    'ps',
    'pkill',
  ].join('|');
  return new RegExp(
    [
      String.raw`\brunAppleToolCommand\b`,
      String.raw`\brunCommand\s*\(\s*['"](?:${hostTools})['"]`,
      String.raw`\bassertFlatToolCall\([^,\n]+,\s*\[\s*['"](?:${hostTools})['"]`,
      String.raw`\bcalls\.push\(\[\s*['"](?:${hostTools})['"]`,
    ].join('|'),
    'g',
  );
}

function countSurfaceReferences(files, pattern) {
  let references = 0;
  let filesWithReferences = 0;
  for (const file of files) {
    const matches = countPatternReferences(fs.readFileSync(file, 'utf8'), pattern);
    references += matches;
    filesWithReferences += matches > 0 ? 1 : 0;
  }
  return { references, files: filesWithReferences };
}

function countPatternReferences(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function summarizePublicCommandCoverage(files, clientCommandMethods) {
  const publicCommands = readPublicCommands();
  const commandRefsByFile = files.map((file) => ({
    file,
    commands: extractProviderScenarioCommandReferences(
      fs.readFileSync(file, 'utf8'),
      clientCommandMethods,
    ),
  }));

  return publicCommands.map((command) => {
    let references = 0;
    let filesWithReferences = 0;
    for (const file of commandRefsByFile) {
      const count = file.commands.filter((candidate) => candidate === command).length;
      references += count;
      if (count > 0) filesWithReferences += 1;
    }
    return { command, references, files: filesWithReferences };
  });
}

function readPublicCommands() {
  const metadataNames = new Set(listCommandMetadata().map((metadata) => metadata.name));
  return Object.values(PUBLIC_COMMANDS)
    .map((name) => {
      if (!metadataNames.has(name)) {
        throw new Error(`Missing command metadata for public command: ${name}`);
      }
      return name;
    })
    .sort();
}

function readClientCommandMethods(commandContractFiles) {
  const commands = new Map();
  for (const file of commandContractFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const block of readCommandContractBlocks(text)) {
      for (const method of block.source.matchAll(
        /\bclient\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\(/g,
      )) {
        commands.set(`${method[1]}.${method[2]}`, block.name);
      }
    }
  }
  return commands;
}

function readCommandContractBlocks(text) {
  const constants = new Map();
  for (const match of text.matchAll(/\bconst\s+([A-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g)) {
    constants.set(match[1], match[2]);
  }

  const metadataNames = new Map();
  for (const match of text.matchAll(
    /\bconst\s+([A-Za-z0-9_]+CommandMetadata)\s*=\s*defineFieldCommandMetadata\(\s*([^,\s)]+)/g,
  )) {
    metadataNames.set(match[1], readMetadataName(match[2], constants));
  }

  const starts = [
    ...text.matchAll(/defineExecutableCommand\(\s*metadata\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...[...text.matchAll(/defineExecutableCommand\(\s*([A-Za-z0-9_]+CommandMetadata)\b/g)].flatMap(
      (match) => {
        const name = metadataNames.get(match[1]);
        return name ? [{ ...match, 1: name }] : [];
      },
    ),
    ...text.matchAll(/defineFieldCommand\(\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/defineCommand\(\s*\{[\s\S]*?\bname:\s*['"]([^'"]+)['"]/g),
  ]
    .map((match) => ({
      index: match.index ?? 0,
      name: match[1],
    }))
    .sort((a, b) => a.index - b.index);

  return starts.map((start, index) => {
    const end = starts[index + 1]?.index ?? text.length;
    return {
      name: start.name,
      source: text.slice(start.index, end),
    };
  });
}

function readMetadataName(token, constants) {
  const literal = token.match(/^['"]([^'"]+)['"]$/);
  if (literal) return literal[1];
  return constants.get(token);
}

function extractProviderScenarioCommandReferences(text, clientCommandMethods) {
  return [
    ...extractLiteralCommandReferences(text),
    ...extractClientCommandReferences(text, clientCommandMethods),
  ];
}

function extractLiteralCommandReferences(text) {
  const commands = [];
  for (const match of text.matchAll(
    /\bcommand:\s*['"]([^'"]+)['"]|\.callCommand\(\s*['"]([^'"]+)['"]/g,
  )) {
    commands.push(match[1] ?? match[2]);
  }
  return commands;
}

function extractClientCommandReferences(text, clientCommandMethods) {
  const commands = [];
  for (const [method, command] of clientCommandMethods) {
    const escapedMethod = method.replace('.', '\\.');
    const matches = countPatternReferences(text, new RegExp(`\\.${escapedMethod}\\s*\\(`, 'g'));
    for (let index = 0; index < matches; index += 1) commands.push(command);
  }
  return commands;
}

function countTestDeclarations(text) {
  return [...text.matchAll(/(?:^|[^\w.])test\(/g)].length;
}

function readCoverageSummary(coverageSummary) {
  const total = readCoverageSummaryJson(coverageSummary)?.total;
  if (!total) return null;
  return {
    statements: readCoveragePercent(total, 'statements'),
    branches: readCoveragePercent(total, 'branches'),
    functions: readCoveragePercent(total, 'functions'),
    lines: readCoveragePercent(total, 'lines'),
  };
}

function readLowCoverageFiles(root, coverageSummary) {
  const summary = readCoverageSummaryJson(coverageSummary);
  if (!summary) return [];
  return Object.entries(summary)
    .filter(([file]) => file !== 'total')
    .map(([file, value]) => readLowCoverageFile(root, file, value))
    .filter((file) => file.statementTotal >= 10 && file.statementPercent < 60)
    .sort((a, b) => b.missingStatements - a.missingStatements)
    .slice(0, 10);
}

function readCoverageSummaryJson(coverageSummary) {
  if (!fs.existsSync(coverageSummary)) return null;
  return JSON.parse(fs.readFileSync(coverageSummary, 'utf8'));
}

function readCoveragePercent(total, key) {
  return Number((total[key] ?? EMPTY_COVERAGE_METRIC).pct);
}

function readLowCoverageFile(root, file, value) {
  const statements = value.statements ?? EMPTY_STATEMENT_COVERAGE;
  const statementTotal = Number(statements.total);
  const statementCovered = Number(statements.covered);
  return {
    file: path.relative(root, file),
    statementPercent: Number(statements.pct),
    statementTotal,
    missingStatements: statementTotal - statementCovered,
  };
}

function ratio(numerator, denominator) {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}
