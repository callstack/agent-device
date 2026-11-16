package com.callstack.agentdevice.snapshothelper;

public final class FillTextEntryTimeTest {
  private FillTextEntryTimeTest() {}

  static void run() {
    entersTextWhenTheAccessibilityTimeoutStillFits();
    refusesTextEntryWithATypedBudgetRefusalWhenItNoLongerFits();
  }

  private static void entersTextWhenTheAccessibilityTimeoutStillFits() {
    AutomationCommandHandler.requireTextEntryTime(15_000, 10_000);
  }

  private static void refusesTextEntryWithATypedBudgetRefusalWhenItNoLongerFits() {
    try {
      AutomationCommandHandler.requireTextEntryTime(14_999, 10_000);
    } catch (AutomationCommandHandler.InputBudgetExhausted refusal) {
      String expected = "Fill text was not entered: too little time left after focus";
      if (!expected.equals(refusal.getMessage())) {
        throw new AssertionError("Expected " + expected + ", got " + refusal.getMessage());
      }
      return;
    }
    throw new AssertionError("Expected the text entry to be refused");
  }
}
