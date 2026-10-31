type LimrunSelector = { key: 'id' | 'label' | 'text' | 'value'; value: string };

export function toIosSelector(selector: LimrunSelector) {
  if (selector.key === 'id') return { AXUniqueId: selector.value };
  if (selector.key === 'value') return { AXValue: selector.value };
  // The Limrun iOS tree exposes visible text through AXLabel, so both
  // agent-device label and text selectors target the provider's label field.
  return { AXLabel: selector.value };
}
