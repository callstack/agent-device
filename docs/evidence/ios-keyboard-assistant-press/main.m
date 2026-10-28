#import <UIKit/UIKit.h>

@interface AssistantProbeController : UIViewController
@property(nonatomic, strong) UITextField *field;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic) NSUInteger actions;
@end

@implementation AssistantProbeController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.field = [[UITextField alloc] initWithFrame:CGRectMake(24, 100, 500, 48)];
  self.field.borderStyle = UITextBorderStyleRoundedRect;
  self.field.placeholder = @"Probe input";
  self.field.accessibilityIdentifier = @"probe-input";
  self.field.autocorrectionType = UITextAutocorrectionTypeNo;
  UIBarButtonItem *action = [[UIBarButtonItem alloc] initWithTitle:@"Assistant action"
      style:UIBarButtonItemStylePlain target:self action:@selector(assistantAction:)];
  action.accessibilityIdentifier = @"assistant-action";
  self.field.inputAssistantItem.allowsHidingShortcuts = NO;
  self.field.inputAssistantItem.leadingBarButtonGroups = @[
    [[UIBarButtonItemGroup alloc] initWithBarButtonItems:@[action] representativeItem:nil]
  ];
  self.field.inputAssistantItem.trailingBarButtonGroups = @[];
  [self.view addSubview:self.field];
  self.status = [[UILabel alloc] initWithFrame:CGRectMake(24, 170, 500, 48)];
  self.status.accessibilityIdentifier = @"assistant-status";
  self.status.text = @"Assistant actions: 0";
  [self.view addSubview:self.status];
}
- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  [self.field becomeFirstResponder];
}
- (void)assistantAction:(id)sender {
  self.actions += 1;
  self.status.text = [NSString stringWithFormat:@"Assistant actions: %lu", (unsigned long)self.actions];
}
@end

@interface AssistantProbeScene : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation AssistantProbeScene
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [AssistantProbeController new];
  [self.window makeKeyAndVisible];
}
@end

@interface AssistantProbeApp : UIResponder <UIApplicationDelegate>
@end
@implementation AssistantProbeApp
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Probe" sessionRole:session.role];
  configuration.delegateClass = AssistantProbeScene.class;
  return configuration;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(AssistantProbeApp.class));
  }
}
