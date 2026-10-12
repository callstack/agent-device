import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import {
  isJsonObject,
  readBooleanProperty,
  readProperty,
  readStringProperty,
  type JsonObject,
} from './json-utils.ts';
import type { WebSnapshotResult } from './provider.ts';

type SnapshotRefRecord = {
  ref: string;
  data?: JsonObject;
};

type SnapshotDraftNode = {
  /** The backend ref an action resolves against; absent for content nothing addresses. */
  ref?: string;
  node: RawSnapshotNode;
};

/**
 * Ref-less roles the backend emits as text that no reader asked for. `ListMarker` is the bullet a
 * list item renders: on a page of list items it is one node per item and says nothing about them.
 *
 * Ref-less lines that carry no text (`form`, `list`, `paragraph`) are not nodes either — their
 * content arrives on their own child lines. That is why the backend's own `--compact` flag cannot
 * serve a capture that has to see text: it drops an empty container TOGETHER with the text under it,
 * so a status region that just announced something disappears from the tree entirely.
 */
const PRESENTATIONAL_REFLESS_ROLES = new Set(['listmarker']);

/**
 * The ref-less role a `<label>` element reports. Its text line and the accessible name of the
 * control it labels are the same string, which is the one duplication the projection resolves by
 * dropping the text — see `isTextAlreadyReported`.
 */
const LABEL_ELEMENT_ROLES = new Set(['labeltext']);

/**
 * The bounds of every ref the capture published, in one call.
 *
 * Grouping the refs into backend round trips is the fetcher's decision, not the projection's: what
 * the capture owes this seam is the question, and only the fetcher can weigh how much of it to send
 * at once. A ref the backend could not measure is simply absent from the returned map.
 */
export type SnapshotRectFetch = (refs: readonly string[]) => Promise<Map<string, Rect>>;

export async function normalizeAgentBrowserSnapshot(
  data: unknown,
  fetchRects?: SnapshotRectFetch,
): Promise<WebSnapshotResult> {
  const snapshotText = readStringProperty(data, 'snapshot') ?? '';
  const refs = collectSnapshotRefs(readProperty(data, 'refs'));
  const drafts = parseSnapshotDraftNodes(snapshotText, refs);

  if (fetchRects) await attachDraftRects(drafts, fetchRects);

  return {
    // Preserve each draft's backend ref as the node's `ref`. agent-browser resolves
    // actions (click/fill/hover) against its own `@eN` refs, which are minted in tree
    // order and are NOT dense — so the ref an agent reads off the snapshot must be the
    // backend ref, not a re-minted dense positional ref. `attachRefs` (downstream) keeps
    // it. Without this the snapshot could show `@e3` = username while the action on
    // `@e3` lands on the backend's `@e3` (a different element, e.g. the passcode field).
    // A line the backend issued no ref for stays ref-less: on-screen content a reader sees
    // and a text search finds, which nothing can act on — exactly what the backend itself
    // would refuse the next moment.
    nodes: drafts.map((draft, index) => ({
      ...draft.node,
      index,
      ...(draft.ref === undefined ? {} : { ref: draft.ref }),
    })),
    truncated: readBooleanProperty(data, 'truncated'),
  };
}

async function attachDraftRects(
  drafts: SnapshotDraftNode[],
  fetchRects: SnapshotRectFetch,
): Promise<void> {
  // One fetch for the whole capture. A capture of nothing addressable still comes through, and the
  // fetcher decides not to call the backend for it: that decision belongs with the refusal below.
  const rects = await fetchRects(
    drafts.flatMap((draft) => (draft.ref === undefined ? [] : [draft.ref])),
  );
  for (const draft of drafts) {
    const ref = draft.ref;
    const rect = ref === undefined ? undefined : rects.get(ref);
    if (rect) draft.node.rect = rect;
  }
}

/** One snapshot line, with the node it reports when the backend issued a ref for it. */
type SnapshotLine = {
  line: string;
  depth: number;
  ref: string | null;
  /** Parsed here so the reported-string survey and the tree walk read a line the same way. */
  addressableNode?: RawSnapshotNode;
};

function parseSnapshotDraftNodes(
  snapshotText: string,
  refs: SnapshotRefRecord[],
): SnapshotDraftNode[] {
  const lines = parseSnapshotLines(snapshotText, refs);
  return indexDraftNodes(buildDraftTree(lines, collectAddressableNames(lines, refs), refs));
}

function parseSnapshotLines(
  snapshotText: string,
  refs: readonly SnapshotRefRecord[],
): SnapshotLine[] {
  const byRef = new Map(refs.map((ref) => [ref.ref, ref]));
  return snapshotText.split(/\r?\n/).map((line) => {
    const depth = inferSnapshotDepth(line);
    const ref = extractBrowserRef(line);
    return ref === null
      ? { line, depth, ref }
      : {
          line,
          depth,
          ref,
          addressableNode: snapshotNodeFromLine(line, byRef.get(ref)?.data, depth),
        };
  });
}

/**
 * The kept lines, in tree order.
 *
 * `parentIndexByDepth` records, for the most recent line at each depth, the index of the kept node
 * its children belong under. A line that is kept records itself; a line that is dropped records its
 * OWN parent, which is how the children of a dropped container re-parent to the container's parent
 * instead of to whichever sibling happened to be kept last.
 *
 * `labelElementByDepth` carries one boolean the same way, for the same reason: it says whether the
 * subtree under the most recent line at that depth renders inside a `<label>` element.
 */
function buildDraftTree(
  lines: readonly SnapshotLine[],
  reportedByLabels: ReadonlySet<string>,
  refs: readonly SnapshotRefRecord[],
): SnapshotDraftNode[] {
  const drafts: SnapshotDraftNode[] = [];
  const seenRefs = new Set<string>();
  const parentIndexByDepth = new Map<number, number | undefined>();
  const labelElementByDepth = new Map<number, boolean>();

  for (const entry of lines) {
    const parentIndex = findParentIndex(parentIndexByDepth, entry.depth);
    const context = resolveLineContext(drafts, parentIndex, labelElementByDepth, entry.depth);
    const draft = draftFromLine(entry, reportedByLabels, context);
    labelElementByDepth.set(
      entry.depth,
      isLabelElementLine(entry) ? true : context.insideLabelElement,
    );
    if (draft) {
      if (entry.ref !== null) seenRefs.add(entry.ref);
      if (parentIndex !== undefined) draft.node.parentIndex = parentIndex;
      parentIndexByDepth.set(entry.depth, drafts.length);
      drafts.push(draft);
      continue;
    }
    parentIndexByDepth.set(entry.depth, parentIndex);
  }

  for (const ref of refs) {
    if (seenRefs.has(ref.ref)) continue;
    drafts.push({ ref: ref.ref, node: snapshotNodeFromMetadata(ref.data) });
  }
  return drafts;
}

/** Where a ref-less line sits, for the two structural duplicates it could be. */
type ReflessLineContext = {
  /** The line renders inside a `<label>` element, which the control it labels answers for. */
  insideLabelElement: boolean;
  /** The nearest kept ancestor that has a ref, i.e. the control this line could sit inside. */
  addressedAncestor?: SnapshotDraftNode;
};

/**
 * Reads both of the walk's inherited facts for one line: whether the recorded subtree above it
 * renders inside a `<label>` element, and which kept ancestor above it can be addressed.
 */
function resolveLineContext(
  drafts: readonly SnapshotDraftNode[],
  parentIndex: number | undefined,
  labelElementByDepth: Map<number, boolean>,
  depth: number,
): ReflessLineContext {
  const insideLabelElement = findInheritedLabelElement(labelElementByDepth, depth);
  const addressedAncestor = findAddressedAncestor(drafts, parentIndex);
  return {
    insideLabelElement,
    ...(addressedAncestor ? { addressedAncestor } : {}),
  };
}

/** The nearest kept ancestor the backend issued a ref for: the control a nested text line repeats. */
function findAddressedAncestor(
  drafts: readonly SnapshotDraftNode[],
  parentIndex: number | undefined,
): SnapshotDraftNode | undefined {
  let index = parentIndex;
  while (index !== undefined) {
    const draft = drafts[index];
    if (!draft) return undefined;
    if (draft.ref !== undefined) return draft;
    index = draft.node.parentIndex;
  }
  return undefined;
}

/** The node a line reports: the addressable one parsed up front, or the ref-less text it carries. */
function draftFromLine(
  entry: SnapshotLine,
  reportedByLabels: ReadonlySet<string>,
  context: ReflessLineContext,
): SnapshotDraftNode | undefined {
  if (entry.ref !== null) {
    return { ref: entry.ref, node: { ...entry.addressableNode! } };
  }
  return reflessDraftFromLine(entry, reportedByLabels, context);
}

function indexDraftNodes(drafts: SnapshotDraftNode[]): SnapshotDraftNode[] {
  return drafts.map((draft, index) => ({ ...draft, node: { ...draft.node, index } }));
}

/**
 * Every string an agent can address a node BY: the accessible name of each node the backend issued
 * a ref for.
 *
 * A `<label>` element's text and the accessible name of the control it labels are the same string,
 * and the accessibility tree's own rule is that the control answers for the label. Keeping both
 * would publish two matches for `text="Name"` on an ordinary form and make the answer ambiguous, so
 * the label's text line loses to the node that can be acted on — but only for a line that renders
 * inside a `<label>` element (see `isTextAlreadyReported`). A string nothing addresses, or one that
 * only coincidentally repeats a name from elsewhere on the page — the announcement a `status`
 * region just made — stays a node of its own.
 */
function collectAddressableNames(
  lines: readonly SnapshotLine[],
  refs: readonly SnapshotRefRecord[],
): Set<string> {
  const names = new Set<string>();
  for (const entry of lines) {
    if (entry.addressableNode?.label) names.add(entry.addressableNode.label);
  }
  // Refs the snapshot text never showed are nodes too, and report the same strings.
  for (const ref of refs) {
    const label = snapshotNodeFromMetadata(ref.data).label;
    if (label) names.add(label);
  }
  return names;
}

function isLabelElementLine(entry: SnapshotLine): boolean {
  const role = extractRole(entry.line);
  return role !== undefined && LABEL_ELEMENT_ROLES.has(role.toLowerCase());
}

/**
 * The node for a line the backend issued no ref for: text a reader needs and no action can target.
 *
 * The string rides on `value`, not `label`. `label` is the accessible name a selector resolves to
 * the control an action addresses, and a second node claiming it would make every `label="Name"`
 * read refuse as ambiguous. Every text door reads `value` as well as `label` — `wait text`,
 * `find text`, `get text`, `text=`, the scope filter, and the printed line — so the text becomes
 * visible without competing for the name.
 */
function reflessDraftFromLine(
  entry: SnapshotLine,
  reportedByLabels: ReadonlySet<string>,
  context: ReflessLineContext,
): SnapshotDraftNode | undefined {
  const role = extractRole(entry.line);
  if (role && PRESENTATIONAL_REFLESS_ROLES.has(role.toLowerCase())) return undefined;
  const text = extractReflessLineText(entry.line);
  if (!text || isTextAlreadyReported(text, reportedByLabels, context)) return undefined;
  const type = role ?? 'StaticText';
  return {
    node: {
      index: 0,
      type,
      role: type,
      value: text,
      depth: entry.depth,
    },
  };
}

/**
 * Whether this ref-less text line duplicates a control rather than adding content of its own.
 *
 * Only two shapes count, and both are read off the tree rather than off the string:
 *
 * 1. the line renders inside a `<label>` element whose control reports the string as its name;
 * 2. the line sits inside the control itself, which reports the string as its name or as its value
 *    — the way the backend prints the selected option of a combo box twice.
 *
 * Anything else keeps its own node. A page-global "drop what any control anywhere reports" rule
 * would take from the tree precisely the content this capture exists to publish: a `status`
 * announcement that happens to repeat a button's label, or a table cell echoing an input's contents,
 * is content, not a duplicate of a control.
 */
function isTextAlreadyReported(
  text: string,
  reportedByLabels: ReadonlySet<string>,
  context: ReflessLineContext,
): boolean {
  if (context.insideLabelElement && reportedByLabels.has(text)) return true;
  const ancestor = context.addressedAncestor?.node;
  return ancestor?.label === text || ancestor?.value === text;
}

function snapshotNodeFromLine(
  line: string,
  metadata: JsonObject | undefined,
  depth: number,
): RawSnapshotNode {
  const type = extractRole(line) ?? readMetadataString(metadata, ['role', 'type']);
  return {
    index: 0,
    type,
    role: type,
    label: extractQuotedText(line) ?? readMetadataString(metadata, ['label', 'name', 'text']),
    value: extractValue(line) ?? readMetadataString(metadata, ['value']),
    depth,
    enabled:
      readMetadataBoolean(metadata, ['enabled']) ??
      (isLineMarkedDisabled(line) ? false : undefined),
    focused: readMetadataBoolean(metadata, ['focused']),
  };
}

function snapshotNodeFromMetadata(metadata: JsonObject | undefined): RawSnapshotNode {
  const type = readMetadataString(metadata, ['role', 'type']);
  return {
    index: 0,
    type,
    role: type,
    label: readMetadataString(metadata, ['label', 'name', 'text']),
    value: readMetadataString(metadata, ['value']),
    enabled: readMetadataBoolean(metadata, ['enabled']),
    focused: readMetadataBoolean(metadata, ['focused']),
  };
}

/** The text a ref-less line carries: its quoted name, or the value it prints after the role. */
function extractReflessLineText(line: string): string | undefined {
  const quoted = extractQuotedText(line);
  if (quoted) return quoted;
  const role = extractRole(line);
  if (!role) return undefined;
  const trailing = line
    .slice(line.indexOf(role) + role.length)
    .match(/^\s*[:=]\s*(.+)$/)?.[1]
    ?.trim();
  return trailing || undefined;
}

function collectSnapshotRefs(value: unknown): SnapshotRefRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = isJsonObject(entry) ? entry : undefined;
      const ref = normalizeBrowserRef(readMetadataString(record, ['ref', 'id']) ?? String(entry));
      return ref ? [{ ref, data: record }] : [];
    });
  }
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const ref = normalizeBrowserRef(key);
    if (!ref) return [];
    return [{ ref, data: isJsonObject(entry) ? entry : undefined }];
  });
}

function inferSnapshotDepth(line: string): number {
  const leadingWhitespace = line.match(/^\s*/)?.[0].length ?? 0;
  return Math.floor(leadingWhitespace / 2);
}

/** Whether the most recent line recorded above this depth sits inside a `<label>` element. */
function findInheritedLabelElement(
  labelElementByDepth: Map<number, boolean>,
  depth: number,
): boolean {
  for (let candidateDepth = depth - 1; candidateDepth >= 0; candidateDepth -= 1) {
    const recorded = labelElementByDepth.get(candidateDepth);
    if (recorded !== undefined) return recorded;
  }
  return false;
}

/** The nearest line recorded above this depth, or nothing above it at all. */
function findParentIndex(
  parentIndexByDepth: Map<number, number | undefined>,
  depth: number,
): number | undefined {
  for (let candidateDepth = depth - 1; candidateDepth >= 0; candidateDepth -= 1) {
    const parent = parentIndexByDepth.get(candidateDepth);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

function extractBrowserRef(line: string): string | null {
  const annotation = extractNodeAnnotation(line);
  if (annotation) {
    return normalizeBrowserRef(annotation.match(/\bref\s*=\s*['"]?(@?e\d+)['"]?/i)?.[1]);
  }
  return normalizeBrowserRef(stripQuotedText(line).match(/@(e\d+)\b/i)?.[1]);
}

/**
 * Refs are structure, never content: a `ref=eN` annotation or an `@eN` token outside a quoted
 * name. Text that merely mentions something shaped like a ref (`StaticText "retry in e3 seconds"`)
 * names no element, and reading one from it would give a text line a ref that resolves to some
 * other element.
 */
function stripQuotedText(line: string): string {
  return line.replaceAll(/"(?:[^"\\]|\\.)*"/g, '""').replaceAll(/'(?:[^'\\]|\\.)*'/g, "''");
}

function extractNodeAnnotation(line: string): string | undefined {
  return stripQuotedText(line).match(/\[([^\]]*\bref\s*=\s*['"]?@?e\d+[^\]]*)\]\s*(?=:|$)/i)?.[1];
}

function normalizeBrowserRef(value: string | undefined): string | null {
  const ref = value?.trim().replace(/^@/, '');
  return ref && /^e\d+$/i.test(ref) ? ref.toLowerCase() : null;
}

function extractRole(line: string): string | undefined {
  const cleaned = line
    .replaceAll(/\[[^\]]*ref[^\]]*\]/gi, '')
    .replaceAll(/@?e\d+\b/gi, '')
    .replaceAll(/^[\s|├└─>*-]+/g, '')
    .trim();
  return cleaned.match(/^([A-Za-z][\w-]*)\b/)?.[1];
}

/**
 * The quoted name a line carries, with the escapes the backend printed inside it undone: a control
 * named `He said "hello"` is that string, not the `He said \` up to the first inner quote.
 */
function extractQuotedText(line: string): string | undefined {
  const quoted = line.match(/"((?:[^"\\]|\\.)+)"/)?.[1] ?? line.match(/'((?:[^'\\]|\\.)+)'/)?.[1];
  return quoted?.replaceAll(/\\(["'\\])/g, '$1');
}

function isLineMarkedDisabled(line: string): boolean {
  return /\bdisabled\b/i.test(extractNodeAnnotation(line) ?? '');
}

function extractValue(line: string): string | undefined {
  return (
    extractTrailingAriaValue(line) ??
    line
      .match(/\bvalue=(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/i)
      ?.slice(1)
      .find(isString) ??
    line
      .match(/\bvalue:\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/i)
      ?.slice(1)
      .find(isString)
  );
}

function extractTrailingAriaValue(line: string): string | undefined {
  const value = line.match(/\]\s*:\s*(.+)$/)?.[1]?.trim();
  return value || undefined;
}

function readMetadataString(metadata: JsonObject | undefined, keys: string[]): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readMetadataBoolean(
  metadata: JsonObject | undefined,
  keys: string[],
): boolean | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
