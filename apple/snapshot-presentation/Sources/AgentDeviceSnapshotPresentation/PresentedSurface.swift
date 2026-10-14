import Foundation

/// Whether this capture read a modal presentation over the app's own content (#3565). The producer owns
/// the answer, and `absent` is a reading rather than a default, because a consumer arms a dismissal
/// confirmation on it: a capture whose evidence cannot answer says `unknown` instead of staying silent,
/// since silence is also what a producer that never classified publishes.
///
/// Mirrors the TypeScript `PresentedSurface` in `@agent-device/kernel/snapshot`.
public enum PresentedSurface: String, Codable, Equatable {
  /// A presentation covers the content this capture describes.
  case presented
  /// Every window this capture read showed only its own content container.
  case absent
  /// The capture supports neither answer.
  case unknown
}
