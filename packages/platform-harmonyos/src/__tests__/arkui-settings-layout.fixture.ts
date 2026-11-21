/**
 * Sanitized `uitest dumpLayout` shapes from a real Huawei device (nova 14, OpenHarmony 6.1.1,
 * 1084x2412) on Settings > Developer options. Attribute names, spellings, and the nesting that
 * produced #4906 and #4907 are kept; bounds and unrelated attributes are trimmed, and no personal
 * data is carried.
 *
 * The two shapes that matter:
 * - `SwitchMenuComponent` rows, where a `Toggle` reports only its resource id and the words on the
 *   screen are a sibling `Text` of the row container, whose own `id` is the same for every row;
 * - a merged status-bar window, which `dumpLayout` reports beside the application's own content root.
 */

const ARK_UI_BOUNDS = {
  statusBar: '[0,0][1084,105]',
  titleBar: '[0,105][1084,273]',
  backButton: '[48,129][168,249]',
  titleText: '[192,154][717,224]',
  row: '[48,1161][1036,1369]',
  rowTextColumn: '[84,1185][868,1345]',
  title: '[84,1185][435,1241]',
  summary: '[84,1247][743,1345]',
  toggle: '[892,1235][1000,1295]',
} as const;

/** ArkUI reports these fields on every node; the mapping reads only a few of them. */
function arkUiAttributes(
  type: string,
  attributes: Record<string, string> = {},
): Record<string, string> {
  return {
    type,
    bounds: ARK_UI_BOUNDS.statusBar,
    clickable: 'false',
    description: '',
    enabled: 'true',
    focused: 'false',
    id: '',
    key: '',
    text: '',
    originalText: '',
    visible: 'true',
    ...attributes,
  };
}

/** The status-bar window of `com.ohos.sceneboard`, merged into the same dump as the app's tree. */
function statusBarWindow() {
  return {
    attributes: arkUiAttributes('WindowScene', {
      bounds: ARK_UI_BOUNDS.statusBar,
      id: 'session24',
      key: 'session24',
      hostWindowId: '24',
    }),
    children: [
      {
        attributes: arkUiAttributes('__Common__', {
          bounds: ARK_UI_BOUNDS.statusBar,
          id: 'StatusBarBox',
          hostWindowId: '24',
        }),
        children: [
          {
            attributes: arkUiAttributes('Stack', {
              bounds: ARK_UI_BOUNDS.statusBar,
              hostWindowId: '24',
            }),
            children: [
              {
                // Reports itself clickable and carries no text, which is what made it the nearest
                // "label" for the app's back button (#4907).
                attributes: arkUiAttributes('__Common__', {
                  bounds: ARK_UI_BOUNDS.statusBar,
                  clickable: 'true',
                  id: 'StatusBarBridgeView',
                  hostWindowId: '24',
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}

/** One settings row: `SwitchMenuComponent` holds the words, the `Toggle` holds only its id. */
function switchMenuRow(title: string, toggleId: string) {
  return {
    attributes: arkUiAttributes('Flex', {
      bounds: ARK_UI_BOUNDS.row,
      clickable: 'true',
      // Every row on this screen reports the same component id, and a padding blank as its
      // accessibility description.
      description: ' ',
      id: 'SwitchMenuComponent',
      hostWindowId: '179',
    }),
    children: [
      {
        attributes: arkUiAttributes('Column', {
          bounds: ARK_UI_BOUNDS.rowTextColumn,
          text: `${title}, ${title} summary.`,
          originalText: `${title}, ${title} summary.`,
          hostWindowId: '179',
        }),
        children: [
          {
            attributes: arkUiAttributes('Text', {
              bounds: ARK_UI_BOUNDS.title,
              text: title,
              originalText: title,
              hostWindowId: '179',
            }),
          },
          {
            attributes: arkUiAttributes('Text', {
              bounds: ARK_UI_BOUNDS.summary,
              text: `${title} summary.`,
              originalText: `${title} summary.`,
              hostWindowId: '179',
            }),
          },
        ],
      },
      {
        attributes: arkUiAttributes('Toggle', {
          bounds: ARK_UI_BOUNDS.toggle,
          checkable: 'true',
          checked: 'true',
          clickable: 'true',
          id: toggleId,
          hostWindowId: '179',
        }),
      },
    ],
  };
}

/** A settings row whose container renders no words at all, only the toggle. */
function textlessSwitchMenuRow(toggleId: string) {
  return {
    attributes: arkUiAttributes('Flex', {
      bounds: ARK_UI_BOUNDS.row,
      clickable: 'true',
      id: 'SwitchMenuComponent',
      hostWindowId: '179',
    }),
    children: [
      {
        attributes: arkUiAttributes('Toggle', {
          bounds: ARK_UI_BOUNDS.toggle,
          checkable: 'true',
          clickable: 'true',
          id: toggleId,
          hostWindowId: '179',
        }),
      },
    ],
  };
}

/** The navigation bar: an icon-only back `Button` beside the screen title. */
function titleBar(screenTitle: string) {
  return {
    attributes: arkUiAttributes('TitleBar', {
      bounds: ARK_UI_BOUNDS.titleBar,
      hostWindowId: '179',
    }),
    children: [
      {
        attributes: arkUiAttributes('HdsTitleBar', {
          bounds: ARK_UI_BOUNDS.titleBar,
          id: 'HdsTitleBar',
          hostWindowId: '179',
        }),
        children: [
          {
            attributes: arkUiAttributes('Button', {
              bounds: ARK_UI_BOUNDS.backButton,
              clickable: 'true',
              hostWindowId: '179',
            }),
            children: [
              {
                attributes: arkUiAttributes('SymbolGlyph', {
                  bounds: '[72,153][145,225]',
                  hostWindowId: '179',
                }),
              },
            ],
          },
          {
            attributes: arkUiAttributes('Text', {
              bounds: ARK_UI_BOUNDS.titleText,
              text: screenTitle,
              originalText: screenTitle,
              hostWindowId: '179',
            }),
          },
        ],
      },
    ],
  };
}

/** Developer options: the app window plus the merged status-bar window. */
export function harmonyDeveloperOptionsLayout() {
  return {
    attributes: arkUiAttributes('unknown'),
    children: [
      {
        attributes: arkUiAttributes('root', { bounds: '[0,105][1084,2412]', hostWindowId: '179' }),
        children: [
          {
            attributes: arkUiAttributes('Navigation', {
              bounds: '[0,105][1084,2412]',
              hostWindowId: '179',
            }),
            children: [titleBar('Developer options')],
          },
          {
            attributes: arkUiAttributes('List', {
              bounds: '[48,273][1036,2412]',
              hostWindowId: '179',
            }),
            children: [
              {
                attributes: arkUiAttributes('ListItem', {
                  bounds: ARK_UI_BOUNDS.row,
                  hostWindowId: '179',
                }),
                children: [switchMenuRow('USB debugging', 'entry_toggle_usb_debug')],
              },
              {
                attributes: arkUiAttributes('ListItem', {
                  bounds: ARK_UI_BOUNDS.row,
                  hostWindowId: '179',
                }),
                children: [textlessSwitchMenuRow('entry_toggle_unlabelled')],
              },
            ],
          },
        ],
      },
      statusBarWindow(),
    ],
  };
}
