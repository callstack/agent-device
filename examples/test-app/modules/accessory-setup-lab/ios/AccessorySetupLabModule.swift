import AccessorySetupKit
import CoreBluetooth
import ExpoModulesCore
import UIKit

public final class AccessorySetupLabModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AccessorySetupLab")

    AsyncFunction("showPickerAsync") { (promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject(
          Exception(
            name: "UnsupportedOperation",
            description: "AccessorySetupKit requires iOS 18 or later."
          )
        )
        return
      }

      AccessorySetupController.shared.showPicker(promise: promise)
    }.runOnQueue(.main)
  }
}

@available(iOS 18.0, *)
private final class AccessorySetupController {
  static let shared = AccessorySetupController()

  private let session = ASAccessorySession()
  private var isActivated = false
  private var isPickerPresented = false

  func showPicker(promise: Promise) {
    guard !isPickerPresented else {
      promise.reject(
        Exception(
          name: "PickerAlreadyPresented",
          description: "The accessory picker is already presented."
        )
      )
      return
    }

    guard
      let serviceUuid = firstInfoPlistString(forKey: "NSAccessorySetupBluetoothServices")
    else {
      promise.reject(
        Exception(
          name: "MissingAccessoryService",
          description:
            "Set AGENT_DEVICE_TEST_ACCESSORY_SERVICE_UUID before rebuilding the iOS development client."
        )
      )
      return
    }

    if !isActivated {
      session.activate(on: .main) { _ in }
      isActivated = true
    }

    let descriptor = ASDiscoveryDescriptor()
    descriptor.bluetoothServiceUUID = CBUUID(string: serviceUuid)
    descriptor.bluetoothNameSubstring = firstInfoPlistString(
      forKey: "NSAccessorySetupBluetoothNames"
    )

    let productImage = UIImage(
      systemName: "dot.radiowaves.left.and.right",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 64, weight: .regular)
    ) ?? UIImage()
    let displayItem = ASPickerDisplayItem(
      name: descriptor.bluetoothNameSubstring ?? "Test accessory",
      productImage: productImage,
      descriptor: descriptor
    )

    isPickerPresented = true
    session.showPicker(for: [displayItem]) { [weak self] error in
      self?.isPickerPresented = false
      if let error {
        promise.reject(
          Exception(name: "AccessoryPickerFailed", description: error.localizedDescription)
        )
      } else {
        promise.resolve(nil)
      }
    }
  }

  private func firstInfoPlistString(forKey key: String) -> String? {
    let values = Bundle.main.object(forInfoDictionaryKey: key) as? [String]
    return values?.first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
  }
}
