/**
 * Page script that selects the content of the editable field a coordinate fill just clicked. `fill`
 * runs it after the click instead of pressing a select-all shortcut, so a click that misses every
 * editable element cannot send that shortcut to the host menu (#3987).
 *
 * The script answers `selected` only when the element at the click point is the focused text-entry
 * field (or inside it) and its content is selected. Any other answer names why nothing was selected,
 * and the caller refuses the fill before typing.
 */
type PageElement = Record<string, any>;
type PageDocument = Record<string, any>;

declare const document: PageDocument;

function selectFocusedContentInPage(clickX: number, clickY: number): string {
  const TEXT_ENTRY_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];

  const isFrame = (element: PageElement): boolean =>
    element.tagName === 'IFRAME' || element.tagName === 'FRAME';

  // Cross-origin frames answer null: their document is not reachable from this script.
  const frameDocument = (frame: PageElement): PageDocument | null => {
    try {
      return frame.contentDocument ?? null;
    } catch {
      return null;
    }
  };

  const isTextEntry = (element: PageElement): boolean => {
    if (element.tagName === 'TEXTAREA') return !element.readOnly && !element.disabled;
    if (element.tagName === 'INPUT') {
      return (
        !element.readOnly &&
        !element.disabled &&
        TEXT_ENTRY_INPUT_TYPES.includes(String(element.type).toLowerCase())
      );
    }
    return element.isContentEditable === true;
  };

  // The focused element, resolved through open shadow roots and same-origin frames.
  let focusedDocument: PageDocument = document;
  let focused: PageElement | null = document.activeElement;
  while (focused) {
    const shadowFocus = focused.shadowRoot?.activeElement;
    if (shadowFocus) {
      focused = shadowFocus;
    } else if (isFrame(focused)) {
      const inner = frameDocument(focused);
      if (!inner) return 'frame-unreachable';
      focusedDocument = inner;
      focused = inner.activeElement;
    } else {
      break;
    }
  }
  if (!focused || !isTextEntry(focused)) return 'not-editable';

  // The element under the click point, resolved the same way.
  let pointX = clickX;
  let pointY = clickY;
  let hit: PageElement | null = document.elementFromPoint(pointX, pointY);
  while (hit) {
    const shadowHit = hit.shadowRoot?.elementFromPoint(pointX, pointY);
    if (shadowHit && shadowHit !== hit) {
      hit = shadowHit;
    } else if (isFrame(hit)) {
      const inner = frameDocument(hit);
      if (!inner) return 'frame-unreachable';
      const box = hit.getBoundingClientRect();
      pointX -= box.left + hit.clientLeft;
      pointY -= box.top + hit.clientTop;
      const innerHit = inner.elementFromPoint(pointX, pointY);
      if (!innerHit) return 'not-clicked';
      hit = innerHit;
    } else {
      break;
    }
  }
  const clickedFocused =
    hit !== null &&
    (focused.contains(hit) ||
      (typeof hit.closest === 'function' && hit.closest('label')?.control === focused));
  if (!clickedFocused) return 'not-clicked';

  if (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') {
    const root = focused.getRootNode();
    const selection =
      root !== focusedDocument && typeof root.getSelection === 'function'
        ? root.getSelection()
        : focusedDocument.defaultView.getSelection();
    const range = focusedDocument.createRange();
    range.selectNodeContents(focused);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.rangeCount === 1 && selection.toString() === range.toString()
      ? 'selected'
      : 'selection-failed';
  }
  focused.select();
  // Inputs without a text selection (email, number) report a null selectionStart.
  return typeof focused.selectionStart !== 'number' ||
    (focused.selectionStart === 0 && focused.selectionEnd === focused.value.length)
    ? 'selected'
    : 'selection-failed';
}

export function buildSelectFocusedContentEvalScript(x: number, y: number): string {
  return `(${selectFocusedContentInPage.toString()})(${Math.round(x)},${Math.round(y)})`;
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
