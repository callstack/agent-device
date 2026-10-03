/**
 * What a single named top-level declaration says: its content digest, and the
 * type names it references (#1432).
 *
 * The daemon RPC gate needs to answer "did this wire declaration's SHAPE
 * change?" without answering "did this file change?". Hashing whole files
 * would fail on every unrelated edit to `packages/kernel/src/contracts.ts`,
 * and a gate that cries wolf gets its baseline regenerated reflexively —
 * which is exactly how a real break walks through.
 *
 * AST-based (`oxc-parser`, the standing precedent in this repo — see
 * `scripts/layering/facade-exports.ts` for the same reasoning) rather than a
 * regex over `export type X = …`: a regex has to enumerate every declaration
 * FORM by hand, and the one it forgets is the one that slips through. Here it
 * would also have to find the matching brace.
 */

import { createHash } from 'node:crypto';
import { parseSync } from 'oxc-parser';

type Span = { start: number; end: number };
type Node = Record<string, unknown>;

/**
 * Comments and formatting are stripped before hashing, so reflowing a type or
 * rewriting the prose above a field does not move the digest — only the
 * declaration's tokens do. Whitespace collapses to a single space rather than
 * to nothing, so removing a comment cannot fuse two adjacent tokens into one.
 *
 * The normalization is deliberately one-directional: it can only make the
 * digest LESS sensitive (a string literal carrying a run of spaces would
 * normalize), never more. No wire declaration in the manifest contains one,
 * and a miss still leaves a hand-edited ledger line in the diff rather than a
 * silent pass.
 */
function normalize(source: string, span: Span, comments: readonly Span[]): string {
  let text = source.slice(span.start, span.end);
  // Right-to-left so each splice leaves earlier offsets valid.
  const inner = comments
    .filter((comment) => comment.start >= span.start && comment.end <= span.end)
    .sort((a, b) => b.start - a.start);
  for (const comment of inner) {
    text = `${text.slice(0, comment.start - span.start)} ${text.slice(comment.end - span.start)}`;
  }
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * The statement that declares `name`, or null when this one does not.
 *
 * An `export` wrapper stays inside the returned span on purpose: a wire type
 * that stops being exported is a compatibility change for every consumer that
 * imports it, so it must move the digest rather than pass unnoticed.
 */
function matchDeclaration(statement: Node, name: string, file: string): Node | null {
  const inner = (statement.declaration ?? statement) as Node;

  if (inner.type === 'VariableDeclaration') {
    const declarators = inner.declarations as Array<{ id?: { name?: string } }>;
    if (!declarators.some((declarator) => declarator.id?.name === name)) return null;
    if (declarators.length > 1) {
      throw new Error(
        `${file}#${name} shares one statement with ${declarators.length - 1} sibling declarator(s), ` +
          `so its digest could not name only "${name}". Give each wire constant its own statement.`,
      );
    }
    return statement;
  }

  const id = inner.id as { name?: string } | undefined;
  return id?.name === name ? statement : null;
}

function topLevelStatements(file: string, source: string): { body: Node[]; comments: Span[] } {
  const parsed = parseSync(file, source);
  return {
    body: parsed.program.body as unknown as Node[],
    comments: parsed.comments as unknown as Span[],
  };
}

/**
 * Every top-level name a module declares. The closure check needs this to ask
 * "is the type this wire declaration references declared in a file the manifest
 * already draws from?", which is what turns an omitted sibling into a failure.
 */
export function readTopLevelDeclarationNames(file: string, source: string): string[] {
  const names: string[] = [];
  for (const statement of topLevelStatements(file, source).body) {
    const inner = (statement.declaration ?? statement) as Node;
    if (inner.type === 'VariableDeclaration') {
      for (const declarator of inner.declarations as Array<{ id?: { name?: string } }>) {
        if (declarator.id?.name) names.push(declarator.id.name);
      }
      continue;
    }
    const name = (inner.id as { name?: string } | undefined)?.name;
    if (name) names.push(name);
  }
  return names;
}

function findDeclaration(
  file: string,
  source: string,
  name: string,
): { node: Node; span: Span; comments: readonly Span[] } {
  const parsed = topLevelStatements(file, source);
  for (const statement of parsed.body) {
    const node = matchDeclaration(statement, name, file);
    if (node) return { node, span: node as unknown as Span, comments: parsed.comments };
  }
  throw new Error(
    `${file} no longer declares "${name}", which test/wire-compat/surface.ts lists as daemon RPC ` +
      `wire surface. Renaming or removing a wire declaration is a protocol break: point the ` +
      `manifest at the new declaration and follow test/wire-compat/README.md.`,
  );
}

/**
 * Digest of `name` as declared in `source`. Throws when the declaration is
 * absent — the manifest naming a symbol its file no longer declares has to
 * fail loudly rather than silently digest nothing.
 */
export function digestDeclaration(file: string, source: string, name: string): string {
  const { span, comments } = findDeclaration(file, source, name);
  return `sha256:${createHash('sha256')
    .update(normalize(source, span, comments))
    .digest('hex')}`;
}

/**
 * Replaces `from` with `to` **inside `name`'s declaration only**, returning the
 * whole mutated source.
 *
 * The planted-red proofs need this rather than `source.replace`: sibling
 * declarations in the same file share substrings (two functions in
 * `request-progress-protocol.ts` both end their template with the same framing),
 * so a whole-file replace silently mutates the FIRST match and leaves the
 * declaration under test untouched — a vacuous proof that looks like a real one.
 * Throws when `from` is absent from the span, so that case fails loudly.
 */
export function replaceInDeclaration(
  file: string,
  source: string,
  name: string,
  from: string,
  to: string,
): string {
  const { span } = findDeclaration(file, source, name);
  const declaration = source.slice(span.start, span.end);
  if (!declaration.includes(from)) {
    throw new Error(
      `${file}#${name} does not contain ${JSON.stringify(from)}, so a mutation built on it would ` +
        `be a no-op. Re-point the case at the declaration's current text.`,
    );
  }
  return source.slice(0, span.start) + declaration.replace(from, to) + source.slice(span.end);
}

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node as Node);
  for (const value of Object.values(node as Node)) walk(value, visit);
}

/** Left-most identifier of a type name (`A` in `A.B.C`), or null. */
function rootTypeName(typeName: unknown): string | null {
  let current = typeName as Node | undefined;
  while (current?.type === 'TSQualifiedName') current = current.left as Node;
  const name = (current as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : null;
}

/**
 * Every type name `name`'s declaration references, including the operand of a
 * `typeof` query so alias-of-const unions (`(typeof LEASE_BACKENDS)[number]`)
 * report the const they are derived from.
 *
 * This is what lets the manifest's closure be CHECKED rather than asserted: a
 * wire type that grows a field typed by a sibling declaration in the same file
 * names that sibling here, and the gate can refuse a manifest that omits it.
 * Without it, adding `foo?: NewShape` to `DaemonRequestMeta` would move only
 * `DaemonRequestMeta`'s digest and leave `NewShape` — the thing that actually
 * decides what the peer parses — outside the gate entirely.
 */
export function readTypeReferences(file: string, source: string, name: string): string[] {
  const { node } = findDeclaration(file, source, name);
  const names = new Set<string>();
  // A declaration's own generic parameters (`JsonRpcRequestEnvelope<TParams>`)
  // read as type references but have no declaration site to gate — they are
  // bound right here. Collected across the whole subtree so a nested generic
  // helper's parameters drop out too.
  const typeParameters = new Set<string>();
  walk(node, (child) => {
    if (child.type === 'TSTypeParameter') {
      const bound = (child.name as { name?: unknown } | undefined)?.name;
      if (typeof bound === 'string') typeParameters.add(bound);
    }
    if (child.type === 'TSTypeReference') {
      const referenced = rootTypeName(child.typeName);
      if (referenced) names.add(referenced);
    }
    if (child.type === 'TSTypeQuery') {
      const referenced = rootTypeName(child.exprName);
      if (referenced) names.add(referenced);
    }
  });
  names.delete(name);
  // `x as const` parses as a type reference to the contextual keyword.
  names.delete('const');
  for (const bound of typeParameters) names.delete(bound);
  return [...names].sort();
}
