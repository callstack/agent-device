#import <TargetConditionals.h>

#if TARGET_OS_OSX
#import <Cocoa/Cocoa.h>

@interface AgentDeviceRunnerAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@end

@implementation AgentDeviceRunnerAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;

  NSRect frame = NSMakeRect(0, 0, 360, 220);
  self.window = [[NSWindow alloc] initWithContentRect:frame
                                            styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                       NSWindowStyleMaskMiniaturizable)
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.title = @"Agent Device Runner";

  NSTextField *label = [NSTextField labelWithString:@"Agent Device Runner"];
  label.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
  label.translatesAutoresizingMaskIntoConstraints = NO;

  NSView *contentView = [[NSView alloc] initWithFrame:frame];
  [contentView addSubview:label];
  self.window.contentView = contentView;

  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:contentView.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:contentView.centerYAnchor],
  ]];

  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    AgentDeviceRunnerAppDelegate *delegate = [[AgentDeviceRunnerAppDelegate alloc] init];
    application.delegate = delegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application run];
  }

  return 0;
}

#else
#import <UIKit/UIKit.h>

@interface AgentDeviceRunnerViewController : UIViewController
@end

@implementation AgentDeviceRunnerViewController

- (void)agentDeviceTextEntryDidChange:(UITextField *)textField {
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-disappear-after-input"] &&
      textField.text.length > 0) {
    [textField removeFromSuperview];
  }
}

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = UIColor.whiteColor;

  UILabel *label = [[UILabel alloc] init];
  label.text = @"Agent Device Runner";
  label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
  label.textAlignment = NSTextAlignmentCenter;
  label.translatesAutoresizingMaskIntoConstraints = NO;

  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];

  // Keep the fixture behind a launch argument so normal runner snapshots remain unchanged.
#if TARGET_OS_IOS
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-regression"]) {
    UITextField *textField = [[UITextField alloc] init];
    textField.accessibilityIdentifier = @"agent-device-hardware-keyboard-input";
    textField.borderStyle = UITextBorderStyleRoundedRect;
    textField.inputView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 1, 1)];
    [textField addTarget:self
                  action:@selector(agentDeviceTextEntryDidChange:)
        forControlEvents:UIControlEventEditingChanged];
    textField.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:textField];
    [NSLayoutConstraint activateConstraints:@[
      [textField.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [textField.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
      [textField.widthAnchor constraintEqualToConstant:240],
      [textField.heightAnchor constraintEqualToConstant:44],
    ]];
  }

  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-selector-read-regression"]) {
    NSString *const duplicateIdentifier = @"agent-device-selector-read-duplicate";

    UIButton *visibleButton = [UIButton buttonWithType:UIButtonTypeSystem];
    visibleButton.accessibilityIdentifier = duplicateIdentifier;
    [visibleButton setTitle:@"Readable target" forState:UIControlStateNormal];
    visibleButton.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:visibleButton];

    UILabel *offscreenLabel = [[UILabel alloc] initWithFrame:CGRectMake(-200, -200, 100, 40)];
    offscreenLabel.accessibilityIdentifier = duplicateIdentifier;
    offscreenLabel.text = @"Decorative duplicate";
    [self.view addSubview:offscreenLabel];

    [NSLayoutConstraint activateConstraints:@[
      [visibleButton.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
      [visibleButton.topAnchor constraintEqualToAnchor:label.bottomAnchor constant:24],
    ]];
  }
#endif
}

@end

#if defined(TARGET_OS_VISION) && TARGET_OS_VISION
@interface AgentDeviceRunnerSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AgentDeviceRunnerSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  (void)session;
  (void)connectionOptions;

  if (![scene isKindOfClass:UIWindowScene.class]) {
    return;
  }

  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[AgentDeviceRunnerViewController alloc] init];
  [self.window makeKeyAndVisible];
}

@end
#endif

@interface AgentDeviceRunnerAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AgentDeviceRunnerAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary<UIApplicationLaunchOptionsKey, id> *)launchOptions {
  (void)application;
  (void)launchOptions;

#if defined(TARGET_OS_VISION) && TARGET_OS_VISION
  return YES;
#else
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [[AgentDeviceRunnerViewController alloc] init];
  [self.window makeKeyAndVisible];

  return YES;
#endif
}

#if defined(TARGET_OS_VISION) && TARGET_OS_VISION
- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)connectingSceneSession
                                   options:(UISceneConnectionOptions *)options {
  (void)application;
  (void)connectingSceneSession;
  (void)options;

  UISceneConfiguration *configuration =
      [[UISceneConfiguration alloc] initWithName:@"Default Configuration"
                                     sessionRole:UIWindowSceneSessionRoleApplication];
  configuration.delegateClass = AgentDeviceRunnerSceneDelegate.class;
  return configuration;
}
#endif

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(AgentDeviceRunnerAppDelegate.class));
  }
}

#endif
