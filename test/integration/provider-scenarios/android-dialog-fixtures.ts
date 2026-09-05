/**
 * Scripted Android dialog surfaces for the provider-backed scenarios: runtime permission,
 * native AlertDialog, system (ANR) dialog, a buttonless dialog, and the app-owned sheet that
 * sits underneath them.
 */

export function androidRuntimePermissionXml(): string {
  const packageName = 'com.google.android.permissioncontroller';
  return androidXml([
    rootNode(packageName),
    textNode(
      1,
      'Allow Demo to send you notifications?',
      'com.android.permissioncontroller:id/permission_message',
      packageName,
      '[24,300][366,352]',
    ),
    buttonNode(
      2,
      'Don’t allow',
      'com.android.permissioncontroller:id/permission_deny_button',
      '[52,612][180,664]',
      packageName,
    ),
    buttonNode(
      3,
      'Allow',
      'com.android.permissioncontroller:id/permission_allow_button',
      '[210,612][338,664]',
      packageName,
    ),
    '  </node>',
  ]);
}

export function androidNativeAlertXml(): string {
  return androidDialogXml([
    textNode(2, 'Unsaved changes', 'android:id/alertTitle'),
    textNode(3, 'Leave without saving?', 'android:id/message'),
    buttonNode(4, 'Cancel', 'android:id/button2', '[52,612][180,664]'),
    buttonNode(5, 'Discard', 'android:id/button1', '[210,612][338,664]'),
  ]);
}

export function androidSystemDialogXml(): string {
  const packageName = 'com.android.systemui';
  return androidXml([
    rootNode(packageName),
    textNode(1, 'Demo isn&apos;t responding', 'android:id/alertTitle', packageName),
    textNode(2, 'Do you want to close it?', 'android:id/message', packageName),
    buttonNode(3, 'Close app', 'android:id/button2', '[52,612][180,664]', packageName),
    buttonNode(4, 'Wait', 'android:id/button1', '[210,612][338,664]', packageName),
    '  </node>',
  ]);
}

export function androidButtonlessAlertXml(): string {
  return androidDialogXml([
    textNode(2, 'Unsaved changes', 'android:id/alertTitle'),
    textNode(3, 'Leave without saving?', 'android:id/message'),
  ]);
}

/**
 * A dialog the way a device shows one: in the tree until its button is tapped (or Back is
 * sent), then gone, with the app-owned surface underneath. `show()` brings it back for a
 * second action on the same fixture.
 */
export function dismissibleDialog(dialogXml: () => string) {
  let visible = true;
  return {
    show: () => {
      visible = true;
    },
    snapshotXml: () => (visible ? dialogXml() : androidAppOwnedSheetXml()),
    onAdbExec: (args: string[]) => {
      if (args[0] !== 'shell' || args[1] !== 'input') return;
      if (args[2] === 'tap' || (args[2] === 'keyevent' && args[3] === '4')) visible = false;
    },
  };
}

export function androidAppOwnedSheetXml(): string {
  return androidXml([
    rootNode('com.example.demo', 'com.example.demo:id/root'),
    textNode(1, 'Choose an option', 'com.example.demo:id/title'),
    buttonNode(2, 'Allow', 'com.example.demo:id/allow_button', '[210,612][338,664]'),
    '  </node>',
  ]);
}

function androidDialogXml(children: string[]): string {
  return androidXml([
    rootNode(),
    androidNode({
      index: 1,
      id: 'android:id/parentPanel',
      type: 'android.app.AlertDialog',
      bounds: '[24,240][366,680]',
      selfClosing: false,
    }),
    ...children,
    '    </node>',
    '  </node>',
  ]);
}

function androidXml(body: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    ...body,
    '</hierarchy>',
  ].join('\n');
}

function rootNode(packageName = 'com.example.demo', id = 'android:id/content'): string {
  return androidNode({ index: 0, id, type: 'FrameLayout', packageName, selfClosing: false });
}

function textNode(
  index: number,
  text: string,
  id: string,
  packageName = 'com.example.demo',
  bounds?: string,
): string {
  return androidNode({ index, text, id, packageName, ...(bounds ? { bounds } : {}) });
}

function buttonNode(
  index: number,
  text: string,
  id: string,
  bounds: string,
  packageName = 'com.example.demo',
): string {
  return androidNode({ index, text, id, type: 'Button', packageName, bounds, clickable: true });
}

function androidNode(options: {
  index: number;
  id: string;
  text?: string;
  type?: string;
  packageName?: string;
  bounds?: string;
  clickable?: boolean;
  selfClosing?: boolean;
}): string {
  const type = options.type ?? 'TextView';
  const className = type.includes('.') ? type : `android.widget.${type}`;
  const tagEnd = options.selfClosing === false ? '>' : ' />';
  return [
    `  <node index="${options.index}"`,
    `text="${options.text ?? ''}"`,
    `resource-id="${options.id}"`,
    `class="${className}"`,
    `package="${options.packageName ?? 'com.example.demo'}"`,
    'content-desc=""',
    `bounds="${options.bounds ?? '[48,340][342,392]'}"`,
    `clickable="${options.clickable ? 'true' : 'false'}"`,
    'enabled="true"',
    options.clickable ? 'focusable="true"' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .concat(tagEnd);
}
