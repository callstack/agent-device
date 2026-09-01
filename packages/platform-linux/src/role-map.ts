/**
 * Maps AT-SPI2 role names (as returned by `Atspi.Accessible.getRoleName()`)
 * to the normalized snapshot `type` strings used by the rest of the system.
 *
 * The mapping follows the same conventions as the macOS helper's
 * `normalizedSnapshotType` (SnapshotTraversal.swift) and the Android
 * `normalizeAndroidType` (ui-hierarchy.ts).
 */

const ATSPI_ROLE_MAP: Record<string, string> = {
  // Buttons
  'push button': 'Button',
  'toggle button': 'Button',
  'push button menu': 'Button',

  // Text
  label: 'StaticText',
  static: 'StaticText',
  caption: 'StaticText',
  text: 'TextField',
  entry: 'TextField',
  'password text': 'TextField',
  'spin button': 'TextField',
  terminal: 'TextArea',
  'document text': 'TextArea',
  paragraph: 'TextArea',

  // Windows & frames
  frame: 'Window',
  window: 'Window',
  dialog: 'Dialog',
  alert: 'Alert',
  'file chooser': 'Dialog',
  'color chooser': 'Dialog',
  'font chooser': 'Dialog',

  // Containers & layout
  panel: 'Group',
  filler: 'Group',
  section: 'Group',
  form: 'Group',
  grouping: 'Group',
  'layered pane': 'Group',
  'glass pane': 'Group',
  'root pane': 'Group',
  'option pane': 'Group',
  'internal frame': 'Group',
  'desktop frame': 'Group',
  'block quote': 'Group',
  article: 'Group',
  comment: 'Group',
  landmark: 'Group',
  log: 'Group',
  marquee: 'Group',
  math: 'Group',
  notification: 'Group',
  'content deletion': 'Group',
  'content insertion': 'Group',
  mark: 'Group',
  suggestion: 'Group',

  // Scrolling
  'scroll pane': 'ScrollArea',
  'scroll bar': 'ScrollBar',

  // Menus
  'menu bar': 'MenuBar',
  menu: 'Menu',
  'popup menu': 'Menu',
  'menu item': 'MenuItem',
  'check menu item': 'MenuItem',
  'radio menu item': 'MenuItem',
  'tearoff menu item': 'MenuItem',

  // Toggle/selection
  'check box': 'CheckBox',
  'radio button': 'RadioButton',
  switch: 'Switch',

  // Combo/dropdown
  'combo box': 'ComboBox',

  // Tabs
  'page tab': 'Tab',
  'page tab list': 'TabList',

  // Tables
  table: 'Table',
  'tree table': 'Table',
  'table cell': 'Cell',
  'table row': 'Row',
  'table column header': 'Cell',
  'table row header': 'Cell',
  'column header': 'Cell',
  'row header': 'Cell',

  // Lists
  list: 'List',
  'list item': 'ListItem',
  'list box': 'List',

  // Trees
  tree: 'Tree',
  'tree item': 'TreeItem',
  'description list': 'List',
  'description term': 'ListItem',
  'description value': 'ListItem',

  // Toolbars & status
  'tool bar': 'Toolbar',
  'status bar': 'StatusBar',
  'info bar': 'StatusBar',

  // Sliders & progress
  slider: 'Slider',
  'progress bar': 'ProgressBar',
  'level bar': 'ProgressBar',

  // Media
  image: 'Image',
  icon: 'Image',
  animation: 'Image',
  canvas: 'Image',
  'drawing area': 'Image',
  video: 'Video',
  audio: 'Audio',

  // Links
  link: 'Link',
  hyperlink: 'Link',

  // Separators
  separator: 'Separator',

  // Application
  application: 'Application',

  // Misc
  'tool tip': 'Tooltip',
  timer: 'Timer',
  heading: 'Heading',
  footnote: 'Footnote',
  'title bar': 'TitleBar',
  'date editor': 'DateEditor',
  rating: 'Slider',
};

/**
 * Convert a raw AT-SPI2 role name (e.g., "push button", "menu item") to
 * the normalized type used in snapshot nodes.
 *
 * Falls back to PascalCase of the raw role name when no explicit mapping exists.
 */
export function normalizeAtspiRole(roleName: string): string {
  const normalized = roleName.toLowerCase().trim();
  const mapped = ATSPI_ROLE_MAP[normalized];
  if (mapped) return mapped;

  // Fallback: convert "some role name" to "SomeRoleName"
  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}
