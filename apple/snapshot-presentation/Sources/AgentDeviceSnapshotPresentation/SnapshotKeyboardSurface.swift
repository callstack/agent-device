public enum SnapshotKeyboardSurface {
  public static func isInputAssistant(type: String, identifier: String?) -> Bool {
    type == "Other" && identifier == "SystemInputAssistantView"
  }

  /// Whether a node roots a branch the keyboard owns: the keyboard, one of its keys, or the input
  /// assistant above it.
  public static func isKeyboardBranch(type: String, identifier: String?) -> Bool {
    type == "Keyboard" || type == "Key" || isInputAssistant(type: type, identifier: identifier)
  }
}
