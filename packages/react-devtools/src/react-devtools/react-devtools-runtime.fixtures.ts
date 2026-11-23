import vm from 'node:vm';
import {
  REACT_DEVTOOLS_RUNTIME_GLOBAL,
  REACT_DEVTOOLS_RUNTIME_SOURCE,
  REACT_DEVTOOLS_RUNTIME_VERSION,
} from './react-devtools-runtime.ts';

const OP_ADD = 1;
const OP_REMOVE = 2;
const OP_REORDER_CHILDREN = 3;
const OP_UPDATE_TREE_BASE_DURATION = 4;
const OP_UPDATE_ERRORS_OR_WARNINGS = 5;
const ROOT_TYPE = 11;
export const FUNCTION_TYPE = 5;
export const MEMO_TYPE = 8;
export const SUSPENSE_TYPE = 12;

export type FakeElement = {
  id: number;
  name: string;
  type?: number;
  owner?: number;
  parent?: number;
  key?: string;
  /** The `name` prop React DevTools 7+ shows for Suspense and Activity boundaries. */
  nameProp?: string;
};

export type FakeCommit = {
  timestamp: number;
  duration: number;
  fibers: Array<[id: number, actualMs: number, selfMs: number]>;
  changes?: Array<[id: number, change: Record<string, unknown>]>;
  updaters?: Array<{ id: number; displayName: string }>;
};

type OperationsBatch = {
  root?: boolean;
  add?: FakeElement[];
  remove?: number[];
  baseDurations?: number[];
  reorder?: [parent: number, children: number[]];
  logs?: Array<[id: number, errors: number, warnings: number]>;
  extra?: number[];
  /** React DevTools 7+ layout: each non-root ADD ends with a name-prop string id. */
  nameProps?: boolean;
};

/** Interns strings the way the backend's string table does: 1-based ids, 0 for none. */
class StringTable {
  readonly #strings: string[] = [];

  id(value: string | undefined): number {
    if (value === undefined) return 0;
    let index = this.#strings.indexOf(value);
    if (index === -1) index = this.#strings.push(value) - 1;
    return index + 1;
  }

  encode(): number[] {
    return this.#strings.flatMap((value) => {
      const codePoints = [...value].map((char) => char.codePointAt(0)!);
      return [codePoints.length, ...codePoints];
    });
  }
}

function addOperations(
  elements: FakeElement[],
  strings: StringTable,
  nameProps: boolean,
): number[] {
  return elements.flatMap((element) => [
    OP_ADD,
    element.id,
    element.type ?? FUNCTION_TYPE,
    element.parent ?? 0,
    element.owner ?? 0,
    strings.id(element.name),
    strings.id(element.key),
    ...(nameProps ? [strings.id(element.nameProp)] : []),
  ]);
}

function updateOperations(batch: OperationsBatch): number[] {
  const ops: number[] = [];
  if (batch.remove?.length) ops.push(OP_REMOVE, batch.remove.length, ...batch.remove);
  if (batch.reorder) {
    const [parent, children] = batch.reorder;
    ops.push(OP_REORDER_CHILDREN, parent, children.length, ...children);
  }
  for (const [id, errors, warnings] of batch.logs ?? []) {
    ops.push(OP_UPDATE_ERRORS_OR_WARNINGS, id, errors, warnings);
  }
  for (const id of batch.baseDurations ?? []) ops.push(OP_UPDATE_TREE_BASE_DURATION, id, 1);
  return ops;
}

/**
 * Encodes one backend `operations` batch: renderer id, root id, the string table, then ops. Only
 * the op shapes the runtime reads are produced.
 */
export function encodeOperations(batch: OperationsBatch): number[] {
  const strings = new StringTable();
  const ops = [
    ...(batch.root ? [OP_ADD, 1, ROOT_TYPE, 0, 1, 1, 1] : []),
    ...addOperations(batch.add ?? [], strings, batch.nameProps === true),
    ...updateOperations(batch),
    ...(batch.extra ?? []),
  ];
  const table = strings.encode();
  return [1, 1, table.length, ...table, ...ops];
}

type Listener = (payload: number[]) => void;

/** One renderer interface with an operations queue that flushes like the real backend's. */
export class FakeRendererInterface {
  queue: number[][] | null = [];
  names = new Map<number, string>();
  profiling = false;
  flushes = 0;
  commits: FakeCommit[] = [];
  props = new Map<number, { data: Record<string, unknown>; cleaned: Array<Array<string>> }>();
  /** What `inspectElement` reports for an element, beyond the props above. */
  inspected = new Map<number, Record<string, unknown>>();
  readonly #emit: (event: string, payload: number[]) => void;

  constructor(emit: (event: string, payload: number[]) => void) {
    this.#emit = emit;
  }

  /** Records a commit the way React and the backend would: ops first, then profiling data. */
  commit(operations: number[], profiled?: FakeCommit): void {
    if (this.queue) this.queue.push(operations);
    else this.#emit('operations', operations);
    if (profiled && this.profiling) this.commits.push(profiled);
  }

  flushInitialOperations(): void {
    this.flushes += 1;
    const queued = this.queue ?? [];
    this.queue = null;
    for (const operations of queued) this.#emit('operations', operations);
  }

  startProfiling(): void {
    this.profiling = true;
    this.commits = [];
  }

  stopProfiling(): void {
    this.profiling = false;
  }

  getDisplayNameForElementID(id: number): string | null {
    return this.names.get(id) ?? null;
  }

  getProfilingData(): unknown {
    return {
      dataForRoots: [
        {
          displayName: 'App',
          commitData: this.commits.map((commit) => ({
            timestamp: commit.timestamp,
            duration: commit.duration,
            effectDuration: 0,
            passiveEffectDuration: 0,
            priorityLevel: 'Normal',
            fiberActualDurations: commit.fibers.map(([id, actual]) => [id, actual]),
            fiberSelfDurations: commit.fibers.map(([id, , self]) => [id, self]),
            changeDescriptions: commit.changes ?? [],
            updaters: (commit.updaters ?? []).map((updater) => ({
              ...updater,
              type: FUNCTION_TYPE,
            })),
          })),
        },
      ],
    };
  }

  inspectElement(_requestID: number, id: number): unknown {
    const props = this.props.get(id);
    const inspected = this.inspected.get(id);
    if (!props && !inspected) return { type: 'not-found' };
    return { type: 'full-data', value: { props, ...inspected } };
  }
}

export type FakeRuntimeOptions = {
  /** React DevTools 6 attaches renderer interfaces when React injects; older backends need a frontend. */
  attachAtInject?: boolean;
  /** React Native 0.76+ registers the Fusebox dispatcher; defaults to present. */
  fusebox?: boolean;
  devtoolsCoreModule?: boolean;
  hook?: boolean;
  /** React DevTools 6 hooks carry console settings and attribute logs to components from app start. */
  consoleSettings?: boolean;
  /** React DevTools 7+ renderer interfaces report Suspense toggling and add name props to ADD ops. */
  nameProps?: boolean;
};

/** A JavaScript realm shaped like a React Native dev runtime, with the profiler runtime evaluable. */
export class FakeAppRuntime {
  readonly context: vm.Context;
  readonly renderer: FakeRendererInterface;
  readonly hook: {
    renderers: Map<number, unknown>;
    rendererInterfaces: Map<number, FakeRendererInterface>;
    listeners: Record<string, Listener[]>;
    sub: (event: string, fn: Listener) => () => void;
    emit: (event: string, payload: number[]) => void;
    settings?: { showInlineWarningsAndErrors: boolean };
  };
  readonly nameProps: boolean;
  domainInitializations = 0;
  customConnections = 0;

  constructor(options: FakeRuntimeOptions = {}) {
    const listeners: Record<string, Listener[]> = {};
    const emit = (event: string, payload: number[]) => {
      for (const listener of listeners[event] ?? []) listener(payload);
    };
    this.renderer = new FakeRendererInterface(emit);
    this.nameProps = options.nameProps === true;
    if (this.nameProps) Object.assign(this.renderer, { supportsTogglingSuspense: true });
    this.hook = {
      renderers: new Map([[1, {}]]),
      rendererInterfaces: new Map(),
      listeners,
      sub: (event, fn) => {
        (listeners[event] ??= []).push(fn);
        return () => {
          listeners[event] = (listeners[event] ?? []).filter((listener) => listener !== fn);
        };
      },
      emit,
      ...(options.consoleSettings === false
        ? {}
        : { settings: { showInlineWarningsAndErrors: true } }),
    };
    const attach = () => this.hook.rendererInterfaces.set(1, this.renderer);
    if (options.attachAtInject !== false) attach();
    const globals: Record<string, unknown> = {};
    if (options.hook !== false) globals.__REACT_DEVTOOLS_GLOBAL_HOOK__ = this.hook;
    if (options.fusebox !== false) {
      globals.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__ = {
        initializeDomain: () => {
          this.domainInitializations += 1;
          attach();
        },
      };
    }
    if (options.devtoolsCoreModule) {
      const modules = new Map([
        [
          7,
          {
            isInitialized: true,
            publicModule: {
              exports: {
                connectWithCustomMessagingProtocol: () => {
                  this.customConnections += 1;
                  attach();
                },
              },
            },
          },
        ],
      ]);
      globals.__r = { getModules: () => modules };
    }
    this.context = vm.createContext(globals);
    vm.runInContext('globalThis.globalThis = globalThis;', this.context);
  }

  install(version = REACT_DEVTOOLS_RUNTIME_VERSION): unknown {
    return vm.runInContext(
      `(${REACT_DEVTOOLS_RUNTIME_SOURCE})(${JSON.stringify(version)})`,
      this.context,
    );
  }

  call<T>(method: string, argument?: unknown): T {
    const value = vm.runInContext(
      `${REACT_DEVTOOLS_RUNTIME_GLOBAL}.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`,
      this.context,
    );
    return JSON.parse(value as string) as T;
  }

  /** Mounts elements before profiling, as the app's initial render would. */
  mount(elements: FakeElement[]): void {
    this.renderer.commit(
      encodeOperations({ root: true, add: elements, nameProps: this.nameProps }),
    );
    for (const element of elements) this.renderer.names.set(element.id, element.name);
  }
}
