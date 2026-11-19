export function vphoneSnapshotTreeFixture() {
  return {
    elements: [
      {
        type: 'Application',
        role: 'application',
        label: 'Example',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        visible: 1,
        enabled: true,
      },
      {
        type: 'Button',
        role: 'button',
        label: 'Save',
        identifier: 'save-button',
        value: 1,
        frame: { x: 12.5, y: 40.25, width: 100.5, height: 44.75 },
        visible: 0,
        enabled: false,
        clickable: true,
      },
      {
        role: 'text',
        text: 'Read only',
        rect: [5, 90, 120, 30],
        visible: true,
      },
    ],
  };
}
