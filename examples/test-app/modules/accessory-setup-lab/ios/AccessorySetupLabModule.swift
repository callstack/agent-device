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
            "The development client is missing its AccessorySetupKit test service configuration."
        )
      )
      return
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

    if #available(iOS 26.0, *) {
      let settings = ASPickerDisplaySettings.default
      settings.discoveryTimeout = .short
      session.pickerDisplaySettings = settings
    }

    let presentPicker = { [weak self] in
      guard let self else { return }

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

    isPickerPresented = true
    if isActivated {
      presentPicker()
      return
    }

    session.activate(on: .main) { [weak self] event in
      guard let self, event.eventType == .activated else { return }
      isActivated = true
      presentPicker()
    }
  }

  private func firstInfoPlistString(forKey key: String) -> String? {
    let values = Bundle.main.object(forInfoDictionaryKey: key) as? [String]
    return values?.first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
  }
}
