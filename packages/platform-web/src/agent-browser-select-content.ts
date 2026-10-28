/**
 * Page script that selects the content of the editable field a coordinate fill just clicked. `fill`
 * runs it after the click instead of pressing a select-all shortcut, so a click that misses every
 * editable element cannot send that shortcut to the host menu (#3987).
 *
 * The script answers `selected` only when the element at the click point is the focused text-entry
 * field (or inside it) and its content is selected. Any other answer names why nothing was selected,
 * and the caller refuses the fill before typing.
 *
 * Each function below is serialized into the page, so it may use only the others and page globals.
 */

type PageElement = Record<string, any>;
type PageDocument = Record<string, any>;
type FocusedField = { element: PageElement; document: PageDocument };

declare const document: PageDocument;

function isFrameElement(element: PageElement): boolean {
  return element.tagName === 'IFRAME' || element.tagName === 'FRAME';
}

/** Cross-origin frames answer null: their document is not reachable from this script. */
function readFrameDocument(frame: PageElement): PageDocument | null {
  try {
    return frame.contentDocument ?? null;
  } catch {
    return null;
  }
}

function isTextEntryField(element: PageElement): boolean {
  if (element.tagName === 'TEXTAREA') return !element.readOnly && !element.disabled;
  if (element.tagName === 'INPUT') {
    const type = String(element.type).toLowerCase();
    return (
      !element.readOnly &&
      !element.disabled &&
      ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(type)
    );
  }
  return element.isContentEditable === true;
}

/** The focused element, resolved through open shadow roots and same-origin frames. */
function resolveFocusedField(): FocusedField | string {
  let focusedDocument: PageDocument = document;
  let element: PageElement | null = document.activeElement;
  while (element) {
    const shadowFocus: PageElement | null | undefined = element.shadowRoot?.activeElement;
    if (shadowFocus) {
      element = shadowFocus;
    } else if (isFrameElement(element)) {
      const inner = readFrameDocument(element);
      if (!inner) return 'frame-unreachable';
      focusedDocument = inner;
      element = inner.activeElement;
    } else {
      break;
    }
  }
  return element && isTextEntryField(element)
    ? { element, document: focusedDocument }
    : 'not-editable';
}

/** The element under the click point, resolved through open shadow roots and same-origin frames. */
function resolveClickedElement(clickX: number, clickY: number): PageElement | string | null {
  let pointX = clickX;
  let pointY = clickY;
  let hit: PageElement | null = document.elementFromPoint(pointX, pointY);
  while (hit) {
    const shadowHit: PageElement | null | undefined = hit.shadowRoot?.elementFromPoint(
      pointX,
      pointY,
    );
    if (shadowHit && shadowHit !== hit) {
      hit = shadowHit;
    } else if (isFrameElement(hit)) {
      const inner = readFrameDocument(hit);
      if (!inner) return 'frame-unreachable';
      const box = hit.getBoundingClientRect();
      pointX -= box.left + hit.clientLeft;
      pointY -= box.top + hit.clientTop;
      hit = inner.elementFromPoint(pointX, pointY);
    } else {
      break;
    }
  }
  return hit;
}

function isClickOnField(hit: PageElement, field: PageElement): boolean {
  if (field.contains(hit)) return true;
  return typeof hit.closest === 'function' && hit.closest('label')?.control === field;
}

/** The innermost start or end position of the host's content, where a browser may normalize to. */
function readInnermostBoundary(
  host: PageElement,
  atEnd: boolean,
): { node: PageElement; offset: number } {
  let node = host;
  let child: PageElement | null = atEnd ? node.lastChild : node.firstChild;
  while (child) {
    node = child;
    child = atEnd ? node.lastChild : node.firstChild;
  }
  const length = node.nodeType === 3 ? node.data.length : node.childNodes.length;
  return { node, offset: atEnd ? length : 0 };
}

function selectEditingHostContent(host: PageElement, hostDocument: PageDocument): string {
  const root = host.getRootNode();
  const selection =
    root !== hostDocument && typeof root.getSelection === 'function'
      ? root.getSelection()
      : hostDocument.defaultView.getSelection();
  const range = hostDocument.createRange();
  range.selectNodeContents(host);
  selection.removeAllRanges();
  selection.addRange(range);
  // Compared by boundary points, not text: the rendered text of a selection and the text of a
  // range differ for multiple paragraphs and hidden content, and a browser may normalize the kept
  // range to the innermost nodes. 0 is START_TO_START, 2 is END_TO_END.
  const kept = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
  if (kept === null) return 'selection-failed';
  const start = readInnermostBoundary(host, false);
  const end = readInnermostBoundary(host, true);
  const content = hostDocument.createRange();
  content.setStart(start.node, start.offset);
  content.setEnd(end.node, end.offset);
  const coversHost =
    kept.compareBoundaryPoints(0, content) <= 0 && kept.compareBoundaryPoints(2, content) >= 0;
  return coversHost ? 'selected' : 'selection-failed';
}

function selectControlContent(control: PageElement): string {
  control.select();
  // Email and number inputs have no selection API (selectionStart is null), so select() is the
  // only step there; test/integration/smoke-web-fill.test.ts proves it replaces their value.
  const hasSelectionApi = !['email', 'number'].includes(String(control.type).toLowerCase());
  const covered =
    !hasSelectionApi ||
    (control.selectionStart === 0 && control.selectionEnd === control.value.length);
  return covered ? 'selected' : 'selection-failed';
}

function selectFocusedContent(clickX: number, clickY: number): string {
  const field = resolveFocusedField();
  if (typeof field === 'string') return field;
  const hit = resolveClickedElement(clickX, clickY);
  if (typeof hit === 'string') return hit;
  if (!hit || !isClickOnField(hit, field.element)) return 'not-clicked';
  const tag = field.element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA'
    ? selectControlContent(field.element)
    : selectEditingHostContent(field.element, field.document);
}

const PAGE_SCRIPT_FUNCTIONS = [
  isFrameElement,
  readFrameDocument,
  isTextEntryField,
  resolveFocusedField,
  resolveClickedElement,
  isClickOnField,
  readInnermostBoundary,
  selectEditingHostContent,
  selectControlContent,
  selectFocusedContent,
] as const;

export function buildSelectFocusedContentEvalScript(x: number, y: number): string {
  const body = PAGE_SCRIPT_FUNCTIONS.map((fn) => `${fn.toString()};`).join('');
  return `(()=>{${body}return ${selectFocusedContent.name}(${Math.round(x)},${Math.round(y)})})()`;
}

/** The page script's answer to `eval`, read from the backend's `{ result }` envelope. */
export function readSelectFocusedContentOutcome(data: unknown): {
  selected: boolean;
  cause: string;
} {
  const result =
    typeof data === 'object' && data !== null ? (data as { result?: unknown }).result : undefined;
  const cause = typeof result === 'string' ? result : 'no-answer';
  return { selected: cause === 'selected', cause };
}
