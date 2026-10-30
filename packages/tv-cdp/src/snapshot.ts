import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

const MAX_NODES = 1500;

// Runs in the TV's Chromium, which can be years old: plain ES5-style code only. Rects stay in CSS
// px, the space Input.dispatchMouseEvent takes, so a tap on a node's centre lands on it.
export const SNAPSHOT_EXPRESSION = `(function () {
  var MAX = ${MAX_NODES};
  var INTERACTIVE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
  var TEXT_INPUT = { text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1 };
  var nodes = [];
  var truncated = false;
  var focused = document.activeElement;

  function ownText(el) {
    var text = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var child = el.childNodes[i];
      if (child.nodeType === 3) text += child.nodeValue;
    }
    return text.replace(/\\s+/g, ' ').trim();
  }

  // Ancestors that clip their overflow narrow the box a descendant can show in. Body overflow
  // applies to the viewport instead, so a collapsed body box must not clip.
  function clipTo(el, clip, style, rect) {
    if (el === document.body) return clip;
    var next = { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom };
    if (style.overflowX !== 'visible') { next.left = Math.max(next.left, rect.left); next.right = Math.min(next.right, rect.right); }
    if (style.overflowY !== 'visible') { next.top = Math.max(next.top, rect.top); next.bottom = Math.min(next.bottom, rect.bottom); }
    return next;
  }

  function visible(style, rect, clip, faded) {
    if (faded || rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= clip.top || rect.right <= clip.left || rect.top >= clip.bottom || rect.left >= clip.right) return false;
    return style.visibility !== 'hidden';
  }

  function walk(el, parentIndex, depth, clip, faded) {
    if (nodes.length >= MAX) { truncated = true; return; }
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    if (style.display === 'none') return;
    faded = faded || style.opacity === '0';
    if (style.position === 'fixed') clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    var tabIndex = el.getAttribute('tabindex');
    var role = el.getAttribute('role');
    var interactive = !!INTERACTIVE[el.tagName] || (tabIndex !== null && Number(tabIndex) >= 0);
    var ariaLabel = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
    var text = ownText(el);
    var keep = visible(style, rect, clip, faded) && (interactive || !!role || !!ariaLabel || !!text);
    var index = parentIndex;
    if (keep) {
      index = nodes.length;
      var label = ariaLabel || text ||
        (interactive ? (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '');
      var inputType = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      var editable = !!TEXT_INPUT[inputType] || el.tagName === 'TEXTAREA' || el.isContentEditable;
      var node = {
        index: index,
        type: el.tagName.toLowerCase(),
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        depth: depth,
        focused: el === focused,
        hittable: interactive,
        enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
        visibleToUser: true
      };
      if (parentIndex >= 0) node.parentIndex = parentIndex;
      if (role) node.role = role;
      if (label) node.label = label;
      if (el.id || el.getAttribute('data-testid')) node.identifier = el.getAttribute('data-testid') || el.id;
      if (editable) { node.editable = true; node.placeholder = el.getAttribute('placeholder') || undefined; }
      if (inputType === 'password') node.password = true;
      else if (editable && el.value !== undefined) node.value = el.value;
      if (el.getAttribute('aria-selected') === 'true') node.selected = true;
      if (el.getAttribute('aria-checked') === 'true') node.checked = true;
      nodes.push(node);
      depth++;
    }
    var childClip = clipTo(el, clip, style, rect);
    for (var i = 0; i < el.children.length; i++) walk(el.children[i], index, depth, childClip, faded);
  }

  if (document.body) walk(document.body, -1, 0, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, false);
  return { nodes: nodes, truncated: truncated, title: document.title };
})()`;

export type SnapshotCapture = Readonly<{
  nodes: RawSnapshotNode[];
  truncated: boolean;
  title: string;
}>;
