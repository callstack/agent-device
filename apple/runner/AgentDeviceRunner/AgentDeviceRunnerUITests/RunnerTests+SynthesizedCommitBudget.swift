import XCTest

// How long the synthesized text-entry commit wait keeps looking. Split out of
// RunnerTests+SynthesizedTextEntry.swift only to keep that file inside its size budget; the
// policy is consumed exclusively by the two commit waits there, which is also where it is tested.
extension RunnerTests {
  /// One commit wait's deadline.
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
  /// Owned by the wait that creates it: `awaitSynthesizedCommitOutcome` and its replacement
  /// counterpart hold it as a local `var` across their own poll loop, so recording progress and
  /// asking whether time is up are two statements in one function rather than a coupling between
  /// separate closures.
  struct SynthesizedCommitBudget {
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

    /// The budget the shipped `type`/`fill` waits run under.
    static func standard(startedAt: Date) -> SynthesizedCommitBudget {
      SynthesizedCommitBudget(
        startedAt: startedAt,
        stallBudget: TextEntryTiming.synthesizedCommitStallTimeout,
        ceiling: TextEntryTiming.synthesizedCommitCeiling
      )
    }

    /// Records one observation's expected-prefix length. Only forward movement counts: a shorter
    /// read (the app clearing the field mid-flight, an unreadable poll reporting -1) is not
    /// evidence the burst is still landing, so it neither buys time nor takes any back.
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
