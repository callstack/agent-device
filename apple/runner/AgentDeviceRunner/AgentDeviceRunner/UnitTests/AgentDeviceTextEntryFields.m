#import "AgentDeviceTextEntryFields.h"

#if TARGET_OS_IOS && defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
@implementation AgentDeviceMaskedTextField
- (NSString *)accessibilityValue {
  NSUInteger length = self.text.length;
  if (length == 0) {
    return [super accessibilityValue];
  }
  NSUInteger bullets = MAX((NSUInteger)1, length / 2);
  return [@"" stringByPaddingToLength:bullets withString:@"\u2022" startingAtIndex:0];
}
@end

@implementation AgentDeviceSecureEntryField {
  NSUInteger _deletes;
  NSUInteger _taps;
}
- (instancetype)init {
  self = [super init];
  if (self) {
    UITapGestureRecognizer *tapCounter = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(countTap:)];
    tapCounter.cancelsTouchesInView = NO;
    tapCounter.delegate = self;
    [self addGestureRecognizer:tapCounter];
  }
  return self;
}

- (void)countTap:(UITapGestureRecognizer *)recognizer {
  (void)recognizer;
  _taps += 1;
  [self showCounts];
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer {
  (void)gestureRecognizer;
  (void)otherGestureRecognizer;
  return YES;
}

- (void)showCounts {
  self.countLabel.text = [NSString stringWithFormat:@"deletes=%lu taps=%lu", (unsigned long)_deletes, (unsigned long)_taps];
}

- (BOOL)becomeFirstResponder {
  if (self.refusesFirstFocus) {
    self.refusesFirstFocus = NO;
    return NO;
  }
  return [super becomeFirstResponder];
}

- (void)deleteBackward {
  _deletes += 1;
  [self showCounts];
  [super deleteBackward];
}

- (NSString *)accessibilityValue {
  if (self.reportsPlaceholderAsValue && self.text.length == 0) {
    return self.placeholder;
  }
  return [super accessibilityValue];
}
@end

static NSUInteger AgentDeviceTextEntryValueReads = 0;

@implementation AgentDeviceValueReadCountingTextField
- (NSString *)accessibilityValue {
  AgentDeviceTextEntryValueReads += 1;
  return [super accessibilityValue];
}
@end

@implementation AgentDeviceValueReadCountLabel
- (NSString *)accessibilityLabel {
  if ([self.countedField isKindOfClass:[AgentDeviceTextEntryWitnessField class]]) {
    return self.countedField.accessibilityHint;
  }
  return [NSString stringWithFormat:@"%lu", (unsigned long)AgentDeviceTextEntryValueReads];
}

- (NSString *)accessibilityValue {
  return self.countedField.text;
}

@end

@interface AgentDeviceTextEntryWitnessField ()
@property(nonatomic, assign) NSUInteger taps;
@property(nonatomic, assign) NSUInteger selections;
@property(nonatomic, assign) NSUInteger rejectedEdits;
@property(nonatomic, assign) BOOL rejectNextSelectionDeletion;
@end

@implementation AgentDeviceTextEntryWitnessField
- (instancetype)init {
  self = [super init];
  if (self) {
    self.delegate = self;
    self.autocorrectionType = UITextAutocorrectionTypeNo;
    self.autocapitalizationType = UITextAutocapitalizationTypeNone;
    UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(recordTap:)];
    tap.cancelsTouchesInView = NO;
    tap.delegate = self;
    [self addGestureRecognizer:tap];
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-witness-prefill"]) {
      self.text = @"seedvalue";
    }
  }
  return self;
}

- (void)recordTap:(UITapGestureRecognizer *)recognizer {
  (void)recognizer;
  self.taps += 1;
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer {
  (void)gestureRecognizer;
  (void)otherGestureRecognizer;
  return YES;
}

- (void)selectAll:(id)sender {
  self.selections += 1;
  self.rejectNextSelectionDeletion =
      [NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-witness-refuse-selection"];
  [super selectAll:sender];
}

- (BOOL)textField:(UITextField *)textField shouldChangeCharactersInRange:(NSRange)range replacementString:(NSString *)string {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  if ([arguments containsObject:@"--agent-device-text-entry-witness-refuse-edits"] ||
      (self.rejectNextSelectionDeletion && range.length > 1 && string.length == 0)) {
    self.rejectNextSelectionDeletion = NO;
    self.rejectedEdits += 1;
    UITextPosition *start = textField.beginningOfDocument;
    textField.selectedTextRange = [textField textRangeFromPosition:start toPosition:start];
    return NO;
  }
  return YES;
}

- (NSString *)accessibilityHint {
  return [NSString stringWithFormat:@"taps=%lu selections=%lu rejected=%lu",
                   (unsigned long)self.taps, (unsigned long)self.selections, (unsigned long)self.rejectedEdits];
}
@end
#endif
