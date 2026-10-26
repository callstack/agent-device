public enum SnapshotKeyboardSurface {
  public static func isInputAssistant(type: String, identifier: String?) -> Bool {
    type == "Other" && identifier == "SystemInputAssistantView"
  }
}
