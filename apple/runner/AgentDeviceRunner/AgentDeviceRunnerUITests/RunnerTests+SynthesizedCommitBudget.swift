import XCTest

// How long the synthesized text-entry commit wait is willing to keep looking. Split out of
// RunnerTests+SynthesizedTextEntry.swift so the policy is a pure, clock-injected value type the
// macOS host lane can exercise without a simulator.
extension RunnerTests {
  /// The commit wait's deadline.
  ///
  /// A synthesized burst can be *throttled* rather than dropped: on a loaded simulator the
  /// characters keep landing, just slowly, and everything touching the input system slows with
  /// them (#1874). A flat wall-clock budget cannot tell that apart from a wedged pipeline, so it
  /// condemned both at the same instant — and the throttled case is a working command reported as
  /// `TEXT_INPUT_COMMIT_NOT_OBSERVED`, which is what turned an environment episode into a red
  /// lane on branches touching no iOS code.
  ///
  /// So time is granted against *progress* — the observed value's expected-prefix growing, the
  /// same length-only evidence `logCommitCadence` already emits — with an absolute ceiling, so a
  /// pipeline that delivers one character per stall window cannot hold a command open forever.
  ///
  /// A pipeline making no progress at all still expires at exactly the `stallBudget` the flat
  /// deadline used, so nothing that fails today starts passing merely by waiting longer: the wait
  /// extends only while characters are still arriving.
  ///
  /// A reference type on purpose. Its two readers are separate escaping closures — the commit
  /// wait's `observe` records into it, its `isExpired` reads it — and the whole fix is the
  /// coupling between them. As a struct that coupling rests on Swift boxing one captured `var`,
  /// which a later refactor could quietly break back into the flat deadline with every test still
  /// green. Sharing one instance makes that unrepresentable instead of merely true today.
  final class SynthesizedCommitBudget {
    let startedAt: Date
    let stallBudget: TimeInterval
    let ceiling: TimeInterval
    private var bestPrefixLength: Int
    private var lastProgressAt: Date

    init(startedAt: Date, stallBudget: TimeInterval, ceiling: TimeInterval) {
      self.startedAt = startedAt
      self.stallBudget = stallBudget
      self.ceiling = ceiling
      // Nothing has landed yet, and an observation of "still nothing" must not read as progress.
      self.bestPrefixLength = 0
      self.lastProgressAt = startedAt
    }

    /// Records one observation's expected-prefix length. Only forward movement counts: a shorter
    /// read (the app clearing the field mid-flight, an unreadable poll reporting -1) is not
    /// evidence the burst is still landing, so it neither buys time nor takes any back.
    func record(expectedPrefixLength: Int, at now: Date) {
      guard expectedPrefixLength > bestPrefixLength else { return }
      bestPrefixLength = expectedPrefixLength
      lastProgressAt = now
    }

    func isExpired(at now: Date) -> Bool {
      now.timeIntervalSince(startedAt) >= ceiling
        || now.timeIntervalSince(lastProgressAt) >= stallBudget
    }
  }
}
