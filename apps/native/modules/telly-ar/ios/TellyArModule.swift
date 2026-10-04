// The phone AR pin for the medicine finder. The web app asks through the WebView bridge
// (app/index.tsx); this module opens a full-screen ARKit screen and answers with the
// contract's reply shapes (minus `requestId`, which the shell adds).
// The module shape follows the expo-modules-core examples (MIT, 650 Industries). The world map
// save and load follow Apple's "Saving and Loading World Data" sample (Apple Sample Code License):
// archive with NSKeyedArchiver, load with `initialWorldMap`.
import ARKit
import AVFoundation
import ExpoModulesCore

func arError(_ code: String, _ message: String) -> [String: Any] {
  return ["type": "ar.error", "code": code, "message": message]
}

enum WorldMapCodec {
  // NSKeyedArchiver, then zlib, then base64 (the contract's `worldMap`).
  static func encode(_ map: ARWorldMap) throws -> Data {
    let archived = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
    return try (archived as NSData).compressed(using: .zlib) as Data
  }

  static func decode(_ base64: String) throws -> ARWorldMap {
    guard let data = Data(base64Encoded: base64) else { throw CocoaError(.coderReadCorrupt) }
    let archived = try (data as NSData).decompressed(using: .zlib) as Data
    guard let map = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: archived) else {
      throw CocoaError(.coderReadCorrupt)
    }
    return map
  }
}

public final class TellyArModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TellyAr")

    AsyncFunction("capabilities") { (promise: Promise) in
      let reply: [String: Any]
      if !ARWorldTrackingConfiguration.isSupported {
        reply = ["supported": false, "reason": "no-arkit"]
      } else {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
          reply = ["supported": false, "reason": "no-camera-permission"]
        default:
          reply = ["supported": true]
        }
      }
      promise.resolve(reply)
    }

    AsyncFunction("savePin") { (containerId: String, label: String, promise: Promise) in
      self.open(.save(containerId: containerId, label: label), promise: promise)
    }
    .runOnQueue(.main)

    // Decoding a large scan runs off the main queue; the screen opens on the main queue.
    AsyncFunction("findPin") { (containerId: String, label: String, anchorId: String, worldMap: String, promise: Promise) in
      let map: ARWorldMap
      do {
        map = try WorldMapCodec.decode(worldMap)
      } catch {
        promise.resolve(arError("failed", "The saved room scan could not be read."))
        return
      }
      // The pin is the anchor with the saved id; a scan without it falls back to the pin's name.
      let pinName = "telly-pin-\(containerId)"
      guard let pin = map.anchors.first(where: { $0.identifier.uuidString == anchorId })
        ?? map.anchors.first(where: { $0.name == pinName })
      else {
        promise.resolve(arError("failed", "The saved room scan has no pin."))
        return
      }
      DispatchQueue.main.async {
        self.open(.find(label: label, pin: pin.identifier, map: map), promise: promise)
      }
    }
  }

  // Main queue only.
  private func open(_ mode: TellyArViewController.Mode, promise: Promise) {
    guard ARWorldTrackingConfiguration.isSupported else {
      promise.resolve(arError("failed", "This phone does not support AR."))
      return
    }
    withCamera(promise) {
      guard let parent = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(arError("failed", "The app has no screen to show AR on."))
        return
      }
      guard !(parent is TellyArViewController) else {
        promise.resolve(arError("failed", "An AR screen is already open."))
        return
      }
      let screen = TellyArViewController(mode: mode) { promise.resolve($0) }
      screen.modalPresentationStyle = .fullScreen
      parent.present(screen, animated: true)
    }
  }

  // Asks for the camera the first time; a refusal answers `camera-denied`.
  private func withCamera(_ promise: Promise, _ start: @escaping () -> Void) {
    let denied = arError("camera-denied", "Camera access is off for this app.")
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      start()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          if granted { start() } else { promise.resolve(denied) }
        }
      }
    default:
      promise.resolve(denied)
    }
  }
}
