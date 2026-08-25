import XCTest

// How long the synthesized text-entry commit wait keeps looking. Split out of
// RunnerTests+SynthesizedTextEntry.swift only to keep that file inside its size budget; the
// policy is consumed exclusively by the two commit waits there, which is also where it is tested.
extension RunnerTests {
  /// How long a commit wait is allowed to keep looking.
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
  struct SynthesizedCommitBudget {
    let stallBudget: TimeInterval
    let ceiling: TimeInterval

    /// The budget the shipped `type`/`fill` waits run under.
    static let standard = SynthesizedCommitBudget(
      stallBudget: TextEntryTiming.synthesizedCommitStallTimeout,
      ceiling: TextEntryTiming.synthesizedCommitCeiling
    )

    /// Starts the clock, and only the poll loop may: the wait's setup reads the field's
    /// placeholder first, which is an AX round-trip that takes seconds on exactly the loaded host
    /// this budget exists for. Time spent there is not time the field was given to commit, and
    /// charging it to the budget made the wait give up sooner than the flat deadline it replaced.
    func deadline(startedAt: Date) -> Deadline {
      Deadline(budget: self, startedAt: startedAt)
    }

    /// One wait's running deadline. Held as a local `var` by the loop that started it, so
    /// recording progress and asking whether time is up are two statements in one function
    /// rather than a coupling between separately-held state.
    struct Deadline {
      private let budget: SynthesizedCommitBudget
      private let startedAt: Date
      // Nothing has landed yet, and an observation of "still nothing" must not read as progress.
      private var bestPrefixLength = 0
      private var lastProgressAt: Date

      init(budget: SynthesizedCommitBudget, startedAt: Date) {
        self.budget = budget
        self.startedAt = startedAt
        self.lastProgressAt = startedAt
      }

      /// Records one observation's expected-prefix length. Only forward movement counts: a
      /// shorter read — the app clearing the field mid-flight, or a value that could not be read
      /// at all, which measures as 0 — is not evidence the burst is still landing, so it neither
      /// buys time nor takes any back.
      mutating func record(expectedPrefixLength: Int, at now: Date) {
        guard expectedPrefixLength > bestPrefixLength else { return }
        bestPrefixLength = expectedPrefixLength
        lastProgressAt = now
      }

      func isExpired(at now: Date) -> Bool {
        now.timeIntervalSince(startedAt) >= budget.ceiling
          || now.timeIntervalSince(lastProgressAt) >= budget.stallBudget
      }
    }
  }
}
