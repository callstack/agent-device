import XCTest

// How long the synthesized text-entry commit wait keeps looking. Split out of
// RunnerTests+SynthesizedTextEntry.swift only to keep that file inside its size budget; the two
// commit waits there are the sole users, and where this is tested.
extension RunnerTests {
  /// One commit wait's running deadline.
  ///
  /// A synthesized burst can be *throttled* rather than dropped: on a loaded simulator the
  /// characters keep landing, just slowly, and everything touching the input system slows with
  /// them (#1874). A flat wall-clock budget cannot tell that apart from a wedged pipeline, so it
  /// condemned both at the same instant — and the throttled case is a working command reported as
  /// `TEXT_INPUT_COMMIT_NOT_OBSERVED`, which is what turned an environment episode into a red
  /// lane on branches touching no iOS code.
  ///
  /// So time is granted against *progress* — the observed value's expected-prefix growing, the
  /// same length-only evidence `logCommitCadence` already emits — with an absolute `ceiling`, so a
  /// pipeline delivering one character per stall window cannot hold a command open forever. A
  /// pipeline making no progress at all still expires at exactly the `stallBudget` the flat
  /// deadline used, so nothing that fails today starts passing merely by waiting longer.
  ///
  /// Started by the poll loop from its own first `now()`, and held as a local `var` there. The
  /// wait's setup reads the field's placeholder first, an AX round-trip that takes seconds on
  /// exactly the loaded host this exists for; charging that to the deadline made the wait give up
  /// sooner than the flat budget it replaced.
  struct SynthesizedCommitDeadline {
    private let startedAt: Date
    private let stallBudget: TimeInterval
    private let ceiling: TimeInterval
    // Nothing has landed yet, and an observation of "still nothing" must not read as progress.
    private var bestPrefixLength = 0
    private var lastProgressAt: Date

    init(startedAt: Date, stallBudget: TimeInterval, ceiling: TimeInterval) {
      self.startedAt = startedAt
      self.stallBudget = stallBudget
      self.ceiling = ceiling
      self.lastProgressAt = startedAt
    }

    /// Records one observation's expected-prefix length. Only forward movement counts: a shorter
    /// read — the app clearing the field mid-flight, or a value that could not be read at all,
    /// which measures as 0 — is not evidence the burst is still landing, so it neither buys time
    /// nor takes any back.
    mutating func record(expectedPrefixLength: Int, at now: Date) {
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
