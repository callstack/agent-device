/** The lazily loaded halves of the process; `bin.ts` supplies the real `import()` calls. */
export type EntryModules = Readonly<{
  help: () => Promise<{
    buildUsageText(): string;
    resolveHelpTargetUsageText(target: string): string | null;
  }>;
  cli: () => Promise<{ runCliProcess(argv: string[]): Promise<unknown> }>;
  mcp: () => Promise<{ runAgentDeviceMcpServer(): Promise<void> }>;
  version: () => Promise<{ readVersion(): string }>;
  processExit: () => Promise<{ exitAfterFlush(code: number): Promise<void> }>;
}>;

export type EntryIo = Readonly<{
  /** The version the bundler baked in; absent when running from source. */
  bundledVersion: string | undefined;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}>;

/** Process entry: the three help/version fast paths, else the MCP server or the full CLI. */
export async function runEntry(argv: string[], modules: EntryModules, io: EntryIo): Promise<void> {
  try {
    await dispatch(argv, modules, io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    // #1596: flush before exiting so a piped caller sees the message.
    await (await modules.processExit()).exitAfterFlush(1);
  }
}

async function dispatch(argv: string[], modules: EntryModules, io: EntryIo): Promise<void> {
  if (argv.length === 0) return await printUsageAndExit(modules, io);
  if (isVersionRequest(argv)) return await printVersion(modules, io);
  const helpTarget = simpleHelpTarget(argv);
  if (helpTarget !== undefined) return await printHelp(helpTarget, argv, modules, io);
  if (isMcpServerRequest(argv)) return await (await modules.mcp()).runAgentDeviceMcpServer();
  await runCli(argv, modules);
}

async function printUsageAndExit(modules: EntryModules, io: EntryIo): Promise<void> {
  io.stdout(`${(await modules.help()).buildUsageText()}\n`);
  await (await modules.processExit()).exitAfterFlush(1);
}

async function printVersion(modules: EntryModules, io: EntryIo): Promise<void> {
  io.stdout(`${io.bundledVersion ?? (await modules.version()).readVersion()}\n`);
}

/** An unknown help topic is left to the full CLI, which owns the error path. */
async function printHelp(
  target: string | null,
  argv: string[],
  modules: EntryModules,
  io: EntryIo,
): Promise<void> {
  const help = await modules.help();
  const text =
    target === null ? `${help.buildUsageText()}\n` : help.resolveHelpTargetUsageText(target);
  if (text === null) return await runCli(argv, modules);
  io.stdout(text);
}

async function runCli(argv: string[], modules: EntryModules): Promise<void> {
  await (await modules.cli()).runCliProcess(argv);
}

function isVersionRequest(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V');
}

function isMcpServerRequest(argv: string[]): boolean {
  return argv[0] === 'mcp' && !argv.some(isHelpFlag);
}

/** `null` = general usage, a string = one command's help, `undefined` = not a help request. */
function simpleHelpTarget(argv: string[]): string | null | undefined {
  const [first, second] = argv;
  if (argv.length === 1) return first === 'help' || isHelpFlag(first) ? null : undefined;
  if (argv.length !== 2) return undefined;
  if (first === 'help') return second;
  return isHelpFlag(second) ? first : undefined;
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}
