import { componentName, componentRef, kindLabel } from './react-component.ts';
import { printable, printableLines } from './react-devtools-text.ts';

type ValuePath = Array<string | number>;

/**
 * A value as the DevTools backend sends it: plain data to a fixed depth, where each path in
 * `cleaned` holds a placeholder describing the value it stands for instead of the value itself.
 */
export type DehydratedValue = {
  data: unknown;
  cleaned: ValuePath[];
  unserializable: ValuePath[];
};

type Placeholder = { type?: string; preview_short?: string; name?: string };

type HookNode = {
  id: number | null;
  name: string;
  value: unknown;
  subHooks: HookNode[];
};

export type InspectedOwner = { id: number; displayName: string | null; key?: string | null };

/** What the in-app runtime returns for one mounted component. */
export type InspectedComponent = {
  name: string | null;
  type: number;
  key: string | null;
  props: DehydratedValue | null;
  state: DehydratedValue | null;
  hooks: DehydratedValue | null;
  context: DehydratedValue | null;
  owners: InspectedOwner[] | null;
  /** `[message, count]` for each distinct error the component logged while rendering. */
  errors: Array<[string, number]>;
  warnings: Array<[string, number]>;
  isErrored: boolean;
};

const STRING_PREVIEW = 60;
const ARRAY_ITEMS = 4;
const OBJECT_KEYS = 5;
const VALUE_WIDTH = 160;
const OWNERS_SHOWN = 4;

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

class ValueFormatter {
  readonly #placeholders: Set<string>;

  constructor(value: DehydratedValue) {
    this.#placeholders = new Set(
      [...value.cleaned, ...value.unserializable].map((path) => JSON.stringify(path)),
    );
  }

  format(value: unknown, path: ValuePath): string {
    if (this.#placeholders.has(JSON.stringify(path))) {
      const placeholder = value as Placeholder;
      return placeholder.preview_short ?? placeholder.name ?? placeholder.type ?? '…';
    }
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string'
        ? JSON.stringify(clip(value, STRING_PREVIEW))
        : String(value);
    }
    if (Array.isArray(value)) {
      const items = value
        .slice(0, ARRAY_ITEMS)
        .map((item, index) => this.format(item, [...path, index]));
      if (value.length > ARRAY_ITEMS) items.push(`…${value.length - ARRAY_ITEMS}`);
      return `[${items.join(', ')}]`;
    }
    const entries = Object.entries(value);
    const shown = entries
      .slice(0, OBJECT_KEYS)
      .map(([key, item]) => `${key}: ${this.format(item, [...path, key])}`);
    if (entries.length > OBJECT_KEYS) shown.push(`…${entries.length - OBJECT_KEYS}`);
    return `{${shown.join(', ')}}`;
  }
}

function recordLines(title: string, value: DehydratedValue | null): string[] {
  if (!value || value.data === null || typeof value.data !== 'object') return [];
  const entries = Object.entries(value.data);
  if (entries.length === 0) return [];
  const formatter = new ValueFormatter(value);
  return [
    `${title}:`,
    ...entries.map(
      ([key, item]) => `  ${key}: ${clip(formatter.format(item, [key]), VALUE_WIDTH)}`,
    ),
  ];
}

/** Hermes stacks name no custom hook, so DevTools wraps each built-in hook in an `anonymous` one. */
function isUnnamedHook(hook: HookNode): boolean {
  return !hook.name || hook.name === 'anonymous';
}

function hookLines(value: DehydratedValue | null): string[] {
  if (!value || !Array.isArray(value.data) || value.data.length === 0) return [];
  const formatter = new ValueFormatter(value);
  const lines = ['hooks:'];
  const visit = (hooks: HookNode[], path: ValuePath, depth: number): void => {
    hooks.forEach((hook, index) => {
      const at = [...path, index];
      const indent = '  '.repeat(depth + 1);
      if (hook.subHooks?.length > 0 && isUnnamedHook(hook)) {
        visit(hook.subHooks, [...at, 'subHooks'], depth);
        return;
      }
      if (hook.subHooks?.length > 0) {
        lines.push(`${indent}${hook.name}:`);
        visit(hook.subHooks, [...at, 'subHooks'], depth + 1);
        return;
      }
      lines.push(
        `${indent}${hook.name}: ${clip(formatter.format(hook.value, [...at, 'value']), VALUE_WIDTH)}`,
      );
    });
  };
  visit(value.data as HookNode[], [], 0);
  return lines;
}

function logLines(label: string, entries: Array<[string, number]>): string[] {
  return entries.map(
    ([message, count]) =>
      `  ${label}: ${clip(printable(message.split('\n')[0] ?? ''), VALUE_WIDTH)}${count > 1 ? ` (x${count})` : ''}`,
  );
}

/** The errors and warnings one component logged while rendering, one line each. */
export function formatComponentLogs(component: InspectedComponent): string[] {
  return [...logLines('error', component.errors), ...logLines('warning', component.warnings)];
}

export function formatInspectedComponent(id: number, component: InspectedComponent): string {
  const key = component.key === null ? '' : ` key=${component.key}`;
  const name = componentName(component.name ?? 'Anonymous');
  const lines = [`${componentRef({ id })} ${name}${kindLabel(component.type)}${key}`];
  const owners = (component.owners ?? []).slice(0, OWNERS_SHOWN);
  if (owners.length > 0) {
    const more = (component.owners?.length ?? 0) > owners.length ? ' < …' : '';
    lines.push(
      `rendered by: ${owners.map((owner) => `${owner.displayName ?? 'Anonymous'} ${componentRef(owner)}`).join(' < ')}${more}`,
    );
  }
  if (component.isErrored) lines.push('error boundary: showing its error state');
  lines.push(
    ...recordLines('props', component.props),
    ...recordLines('state', component.state),
    ...hookLines(component.hooks),
    ...recordLines('context', component.context),
  );
  const logs = formatComponentLogs(component);
  if (logs.length > 0) lines.push('logged while rendering:', ...logs);
  return printableLines(lines);
}
