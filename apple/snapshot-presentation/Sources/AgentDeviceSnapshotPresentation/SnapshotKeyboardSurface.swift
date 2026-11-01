public enum SnapshotKeyboardSurface {
  public static func isInputAssistant(type: String, identifier: String?) -> Bool {
    type == "Other" && identifier == "SystemInputAssistantView"
  }

  /// Whether a node is the keyboard or one of its keys. It says nothing about the input assistant,
  /// which can also host the app's own buttons.
  public static func isKeyboardOrKey(type: String) -> Bool {
    type == "Keyboard" || type == "Key"
  }
}
