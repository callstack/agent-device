import { AppError } from '@agent-device/kernel/errors';
import { targetAppId, type InspectorSession } from './metro-inspector.ts';
import {
  formatComponentLogs,
  formatInspectedComponent,
  type InspectedComponent,
} from './react-component-inspect.ts';
import {
  buildComponentTree,
  componentRef,
  findNodes,
  logSummary,
  matchLine,
  parseRef,
  renderTree,
  resolveNode,
  type ComponentTree,
  type RawComponentTree,
  type TreeNode,
} from './react-component-tree.ts';
import {
  callRuntime,
  emitTo,
  parseDevtoolsArgs,
  runtimeFailure,
  RUNTIME_OPTIONS,
  withAppRuntime,
  type CommandForm,
  type DevtoolsArgs,
  type Emit,
  type ReactDevtoolsCommandOptions,
  type RuntimeFailure,
} from './react-devtools-connection.ts';
import { printable } from './react-devtools-text.ts';

const INSPECT_COMMANDS = ['tree', 'find', 'inspect', 'errors'] as const;

export type InspectCommand = (typeof INSPECT_COMMANDS)[number];

export function isInspectCommand(value: string | undefined): value is InspectCommand {
  return INSPECT_COMMANDS.includes(value as InspectCommand);
}

type TreeResult = ({ ok: true } & RawComponentTree) | RuntimeFailure;
type InspectedResult = InspectedComponent | { missing: true } | { error: string };
type InspectResult = { ok: true; elements: Record<string, InspectedResult> } | RuntimeFailure;

const UNTRACKED_LOGS_NOTE =
  "Note: this app's React DevTools backend does not attribute every console error and warning to a component, so this list can be incomplete; check agent-device logs as well.";

const TREE_DEPTH = 8;
const TREE_LINES = 60;
const FIND_LIMIT = 20;
const ERRORS_LIMIT = 10;

const FORMS: Record<InspectCommand, CommandForm> = {
  tree: { usage: 'tree', positionals: 1, options: [...RUNTIME_OPTIONS, 'depth', 'limit'] },
  find: { usage: 'find <Name>', positionals: 1, options: [...RUNTIME_OPTIONS, 'exact', 'limit'] },
  inspect: { usage: 'inspect <@ref|Name>', positionals: 1, options: RUNTIME_OPTIONS },
  errors: { usage: 'errors', positionals: 0, options: [...RUNTIME_OPTIONS, 'limit'] },
};

async function readTree(session: InspectorSession): Promise<ComponentTree> {
  const result = await callRuntime<TreeResult>(session, 'tree');
  if (!result.ok) throw runtimeFailure(result);
  return buildComponentTree(result);
}

async function inspectIds(
  session: InspectorSession,
  ids: number[],
): Promise<Record<string, InspectedResult>> {
  const result = await callRuntime<InspectResult>(session, 'inspect', ids);
  if (!result.ok) throw runtimeFailure(result);
  return result.elements;
}

function requireInspected(result: InspectedResult | undefined): InspectedComponent {
  if (!result || 'missing' in result) {
    throw runtimeFailure({ ok: false, reason: 'element-not-found' });
  }
  if ('error' in result)
    throw runtimeFailure({ ok: false, reason: 'inspect-failed', detail: result.error });
  return result;
}

function requireTarget(args: DevtoolsArgs, usage: string): string {
  const target = args.positionals[0];
  if (!target) throw new AppError('INVALID_ARGS', `react-devtools ${usage} needs an argument.`);
  return target;
}

type Handler = (
  args: DevtoolsArgs,
  options: ReactDevtoolsCommandOptions,
  emit: Emit,
) => Promise<void>;

const HANDLERS: Record<InspectCommand, Handler> = {
  tree: async (args, options, emit) => {
    const { app, tree, root } = await withAppRuntime(args, options, async (session, target) => {
      const tree = await readTree(session);
      const root = args.positionals[0] ? resolveNode(tree, args.positionals[0]) : undefined;
      return { app: targetAppId(target), tree, root };
    });
    const view = renderTree(
      root ? [root] : tree.roots,
      args.depth ?? TREE_DEPTH,
      args.limit ?? TREE_LINES,
    );
    const scope = root ? `under ${componentRef(root)} ${root.name}` : `in ${app}`;
    const header = `React tree ${scope}: ${view.total} components`;
    const hidden = view.total - view.shown;
    const footer =
      hidden > 0
        ? [
            `+${hidden} components not shown (raise --depth or --limit, or run tree <@ref> on a branch)`,
          ]
        : [];
    emit([header, ...view.lines, ...footer].join('\n'), {
      app,
      root: root ? componentRef(root) : null,
      total: view.total,
      shown: view.shown,
      lines: view.lines,
    });
  },
  find: async (args, options, emit) => {
    const query = requireTarget(args, 'find <Name>');
    const tree = await withAppRuntime(args, options, async (session) => await readTree(session));
    const matches = findNodes(tree, query, args.exact);
    const limit = args.limit ?? FIND_LIMIT;
    const shown = matches.slice(0, limit);
    const header =
      matches.length === 0
        ? `No mounted component name ${args.exact ? 'is' : 'contains'} ${JSON.stringify(query)}.`
        : `${matches.length} mounted ${matches.length === 1 ? 'component matches' : 'components match'} ${JSON.stringify(query)}:`;
    const more =
      matches.length > shown.length
        ? [`  +${matches.length - shown.length} more (--limit ${matches.length})`]
        : [];
    emit([header, ...shown.map((node) => `  ${matchLine(tree, node)}`), ...more].join('\n'), {
      total: matches.length,
      matches: shown.map((node) => matchData(node)),
    });
  },
  inspect: async (args, options, emit) => {
    const target = requireTarget(args, 'inspect <@ref|Name>');
    const { id, component } = await withAppRuntime(args, options, async (session) => {
      const id = parseRef(target) ?? resolveNode(await readTree(session), target).id;
      const elements = await inspectIds(session, [id]);
      return { id, component: requireInspected(elements[String(id)]) };
    });
    emit(formatInspectedComponent(id, component), { ref: componentRef({ id }), ...component });
  },
  errors: async (args, options, emit) => {
    const limit = args.limit ?? ERRORS_LIMIT;
    const { logged, inspected, logsTracked } = await withAppRuntime(
      args,
      options,
      async (session) => {
        const tree = await readTree(session);
        const logged = [...tree.byId.values()]
          .filter((node) => node.errors + node.warnings > 0)
          .sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
        const ids = logged.slice(0, limit).map((node) => node.id);
        return {
          logged,
          inspected: ids.length > 0 ? await inspectIds(session, ids) : {},
          logsTracked: tree.logsTracked,
        };
      },
    );
    const untracked = logsTracked ? [] : [UNTRACKED_LOGS_NOTE];
    if (logged.length === 0) {
      emit(
        ['No mounted component logged an error or warning while rendering.', ...untracked].join(
          '\n',
        ),
        { total: 0, logsTracked, components: [] },
      );
      return;
    }
    const shown = logged.slice(0, limit);
    const lines = [
      `${logged.length} mounted ${logged.length === 1 ? 'component' : 'components'} logged errors or warnings while rendering:`,
    ];
    for (const node of shown) {
      lines.push(`  ${componentRef(node)} ${node.name}: ${logSummary(node)}`);
      const messages = loggedMessages(inspected[String(node.id)]);
      if ('unavailable' in messages)
        lines.push(`    messages unavailable: ${messages.unavailable}`);
      else lines.push(...formatComponentLogs(messages.component).map((line) => `  ${line}`));
    }
    if (logged.length > shown.length)
      lines.push(`  +${logged.length - shown.length} more (--limit ${logged.length})`);
    lines.push(...untracked);
    emit(lines.join('\n'), {
      total: logged.length,
      logsTracked,
      components: shown.map((node) => {
        const messages = loggedMessages(inspected[String(node.id)]);
        return 'unavailable' in messages
          ? { ...matchData(node), messagesUnavailable: messages.unavailable }
          : {
              ...matchData(node),
              errors: messages.component.errors,
              warnings: messages.component.warnings,
            };
      }),
    });
  },
};

/** The inspected component behind a log count, or why its messages could not be read. */
function loggedMessages(
  result: InspectedResult | undefined,
): { component: InspectedComponent } | { unavailable: string } {
  if (!result || 'missing' in result) return { unavailable: 'the component unmounted' };
  if ('error' in result) return { unavailable: printable(result.error) };
  return { component: result };
}

function matchData(node: TreeNode) {
  return {
    ref: componentRef(node),
    name: node.name,
    key: node.key,
    errorCount: node.errors,
    warningCount: node.warnings,
  };
}

export async function runReactInspectCommand(
  command: InspectCommand,
  args: string[],
  options: ReactDevtoolsCommandOptions,
): Promise<number> {
  const parsed = parseDevtoolsArgs(args, () => FORMS[command]);
  await HANDLERS[command](parsed, options, emitTo(options));
  return 0;
}
