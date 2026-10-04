// The full-screen AR screen for saving and finding a medicine pin.
// Ideas from Apple's "Saving and Loading World Data" sample (Apple Sample Code License): save only
// when `worldMappingStatus` is `.mapped` or `.extending`, ask the person to move the phone while
// the session relocalizes, and hide the marker until relocalization ends. No code is copied.
import ARKit
import SceneKit
import UIKit

final class TellyArViewController: UIViewController, ARSCNViewDelegate, ARSessionDelegate {
  enum Mode {
    case save(containerId: String, label: String)
    case find(label: String, pin: UUID, map: ARWorldMap)
  }

  // A find gives up when the room does not match within this time.
  private static let relocalizationTimeout: TimeInterval = 120

  private let mode: Mode
  private var reply: (([String: Any]) -> Void)?
  private let sceneView = ARSCNView()
  private let hint = UILabel()
  private let hintBox = UIView()
  private let closeButton = UIButton(type: .system)
  private let pinButton = UIButton(type: .system)
  private let crosshair = UIView()
  // Find mode: points from the screen edge to the pin while the pin is off screen.
  private let arrow = UIImageView(image: UIImage(systemName: "arrow.up.circle.fill"))
  private let marker: SCNNode
  private var saving = false
  private var found = false
  private var timeout: Timer?

  init(mode: Mode, reply: @escaping ([String: Any]) -> Void) {
    self.mode = mode
    self.reply = reply
    switch mode {
    case .save(_, let label), .find(let label, _, _):
      marker = TellyArViewController.makeMarker(label: label)
    }
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  // A screen that goes away without an answer still settles the promise.
  deinit {
    reply?(arError("cancelled", "The AR screen closed."))
  }

  private var label: String {
    switch mode {
    case .save(_, let label), .find(let label, _, _): return label
    }
  }

  // Called on the SceneKit render queue: reads only immutable state.
  private func isPin(_ anchor: ARAnchor) -> Bool {
    switch mode {
    case .save(let containerId, _): return anchor.name == "telly-pin-\(containerId)"
    case .find(_, let pin, _): return anchor.identifier == pin
    }
  }

  // MARK: - Layout

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    sceneView.delegate = self
    sceneView.session.delegate = self
    sceneView.automaticallyUpdatesLighting = true
    sceneView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(sceneView)

    hint.numberOfLines = 0
    hint.textAlignment = .center
    hint.textColor = .white
    hint.font = UIFont.preferredFont(forTextStyle: .headline)
    hint.adjustsFontForContentSizeCategory = true
    hint.accessibilityTraits = .updatesFrequently
    hint.translatesAutoresizingMaskIntoConstraints = false
    hintBox.backgroundColor = UIColor.black.withAlphaComponent(0.7)
    hintBox.layer.cornerRadius = 12
    hintBox.translatesAutoresizingMaskIntoConstraints = false
    hintBox.addSubview(hint)
    view.addSubview(hintBox)

    var close = UIButton.Configuration.filled()
    close.baseBackgroundColor = UIColor.black.withAlphaComponent(0.7)
    close.baseForegroundColor = .white
    close.title = "Cancel"
    closeButton.configuration = close
    closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(closeButton)

    let guide = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      sceneView.topAnchor.constraint(equalTo: view.topAnchor),
      sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      closeButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
      closeButton.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      hintBox.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 12),
      hintBox.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      hintBox.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      hint.topAnchor.constraint(equalTo: hintBox.topAnchor, constant: 12),
      hint.bottomAnchor.constraint(equalTo: hintBox.bottomAnchor, constant: -12),
      hint.leadingAnchor.constraint(equalTo: hintBox.leadingAnchor, constant: 16),
      hint.trailingAnchor.constraint(equalTo: hintBox.trailingAnchor, constant: -16),
    ])

    if case .save = mode {
      // The dot marks the spot the pin goes to.
      crosshair.backgroundColor = UIColor.white.withAlphaComponent(0.3)
      crosshair.layer.borderColor = UIColor.white.cgColor
      crosshair.layer.borderWidth = 3
      crosshair.layer.cornerRadius = 14
      crosshair.isUserInteractionEnabled = false
      crosshair.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(crosshair)

      var pin = UIButton.Configuration.filled()
      pin.baseBackgroundColor = .systemBlue
      pin.title = "Pin here"
      pin.buttonSize = .large
      pinButton.configuration = pin
      pinButton.isEnabled = false
      pinButton.accessibilityHint = "Saves where the \(label) is."
      pinButton.addTarget(self, action: #selector(pinHere), for: .touchUpInside)
      pinButton.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(pinButton)

      NSLayoutConstraint.activate([
        crosshair.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        crosshair.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        crosshair.widthAnchor.constraint(equalToConstant: 28),
        crosshair.heightAnchor.constraint(equalToConstant: 28),
        pinButton.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
        pinButton.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
        pinButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
      ])
      setHint("Move your phone slowly around the room so it can learn the space.")
    } else {
      arrow.tintColor = .systemRed
      arrow.backgroundColor = .white
      arrow.layer.cornerRadius = 28
      arrow.frame = CGRect(x: 0, y: 0, width: 56, height: 56)
      arrow.isHidden = true
      arrow.isAccessibilityElement = false
      view.addSubview(arrow)
      setHint("Move your phone slowly around the room.")
    }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let configuration = ARWorldTrackingConfiguration()
    configuration.planeDetection = [.horizontal, .vertical]
    if case .find(_, _, let map) = mode {
      configuration.initialWorldMap = map
      marker.isHidden = true
      timeout = Timer.scheduledTimer(withTimeInterval: Self.relocalizationTimeout, repeats: false) { [weak self] _ in
        self?.finish(arError("relocalization-failed", "The room did not match the saved scan."))
      }
    }
    sceneView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    UIApplication.shared.isIdleTimerDisabled = true
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    timeout?.invalidate()
    sceneView.session.pause()
    UIApplication.shared.isIdleTimerDisabled = false
  }

  private func setHint(_ text: String) {
    guard hint.text != text else { return }
    hint.text = text
    UIAccessibility.post(notification: .announcement, argument: text)
  }

  // MARK: - Answers

  private func send(_ answer: [String: Any]) {
    guard let reply else { return }
    self.reply = nil
    reply(answer)
  }

  private func finish(_ answer: [String: Any]) {
    send(answer)
    if presentingViewController != nil { dismiss(animated: true) }
  }

  @objc private func closeTapped() {
    finish(arError("cancelled", "The person closed the AR screen."))
  }

  // MARK: - Save

  @objc private func pinHere() {
    guard case .save(let containerId, _) = mode, !saving else { return }
    let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
    guard let query = sceneView.raycastQuery(from: center, allowing: .estimatedPlane, alignment: .any),
          let hit = sceneView.session.raycast(query).first
    else {
      setHint("Point the dot at a surface where the \(label) is, then tap Pin here.")
      return
    }
    saving = true
    pinButton.isEnabled = false
    setHint("Saving the pin…")
    let anchor = ARAnchor(name: "telly-pin-\(containerId)", transform: hit.worldTransform)
    sceneView.session.add(anchor: anchor)
    sceneView.session.getCurrentWorldMap { [weak self] map, error in
      guard let map else {
        let notReady = (error as? ARError)?.code == .insufficientFeatures
        DispatchQueue.main.async {
          self?.finish(arError(
            notReady ? "mapping-not-ready" : "failed",
            notReady ? "The room scan needs more detail." : "The room scan could not be saved."
          ))
        }
        return
      }
      // The new anchor can miss the map when the session has not processed it yet.
      if !map.anchors.contains(where: { $0.identifier == anchor.identifier }) {
        map.anchors.append(anchor)
      }
      DispatchQueue.global(qos: .userInitiated).async {
        let answer: [String: Any]
        if let data = try? WorldMapCodec.encode(map) {
          answer = [
            "type": "ar.pinSaved",
            "anchorId": anchor.identifier.uuidString,
            "worldMap": data.base64EncodedString(),
            "mapBytes": data.count,
          ]
        } else {
          answer = arError("failed", "The room scan could not be saved.")
        }
        DispatchQueue.main.async { self?.finish(answer) }
      }
    }
  }

  // MARK: - ARSessionDelegate (main queue)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    switch mode {
    case .save:
      guard !saving else { return }
      let ready = frame.worldMappingStatus == .mapped || frame.worldMappingStatus == .extending
      pinButton.isEnabled = ready
      setHint(ready
        ? "Point the dot at the \(label), then tap Pin here."
        : "Move your phone slowly around the room so it can learn the space.")
    case .find:
      guard let pin = frame.anchors.first(where: isPin), case .normal = frame.camera.trackingState else { return }
      if found {
        pointArrow(at: pin)
        return
      }
      found = true
      timeout?.invalidate()
      marker.isHidden = false
      setHint("Your \(label) is at the red dot.")
      var done = closeButton.configuration
      done?.title = "Done"
      closeButton.configuration = done
      send(["type": "ar.pinFound"])
      pointArrow(at: pin)
    }
  }

  // Shows the arrow at the screen edge, toward the pin, when the pin is off screen or behind.
  private func pointArrow(at pin: ARAnchor) {
    let position = pin.transform.columns.3
    let point = sceneView.projectPoint(SCNVector3(position.x, position.y, position.z))
    let bounds = sceneView.bounds
    let behind = point.z > 1
    let onScreen = !behind && bounds.insetBy(dx: 24, dy: 24).contains(CGPoint(x: CGFloat(point.x), y: CGFloat(point.y)))
    let wasHidden = arrow.isHidden
    arrow.isHidden = onScreen
    if onScreen {
      if !wasHidden { setHint("Your \(label) is at the red dot.") }
      return
    }
    // Behind the camera the projection mirrors, so the direction flips.
    var dx = CGFloat(point.x) - bounds.midX
    var dy = CGFloat(point.y) - bounds.midY
    if behind { dx = -dx; dy = -dy }
    let length = max(hypot(dx, dy), 1)
    let radius = min(bounds.width, bounds.height) / 2 - 48
    arrow.center = CGPoint(x: bounds.midX + dx / length * radius, y: bounds.midY + dy / length * radius)
    arrow.transform = CGAffineTransform(rotationAngle: atan2(dx, -dy))
    if wasHidden { setHint("Turn toward the arrow to see your \(label).") }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    let denied = (error as? ARError)?.code == .cameraUnauthorized
    finish(arError(denied ? "camera-denied" : "failed", denied ? "Camera access is off for this app." : "AR stopped working."))
  }

  // MARK: - ARSCNViewDelegate (render queue)

  func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
    return isPin(anchor) ? marker : nil
  }

  // A pulsing red dot with the medicine's name above it, always facing the camera.
  private static func makeMarker(label: String) -> SCNNode {
    let root = SCNNode()

    let sphere = SCNSphere(radius: 0.025)
    sphere.firstMaterial?.diffuse.contents = UIColor.systemRed
    sphere.firstMaterial?.lightingModel = .constant
    let dot = SCNNode(geometry: sphere)
    dot.runAction(.repeatForever(.sequence([
      .scale(to: 1.4, duration: 0.6),
      .scale(to: 1.0, duration: 0.6),
    ])))
    root.addChildNode(dot)

    let text = SCNText(string: label, extrusionDepth: 0)
    text.font = UIFont.systemFont(ofSize: 12, weight: .bold)
    text.flatness = 0.1
    text.firstMaterial?.diffuse.contents = UIColor.white
    text.firstMaterial?.lightingModel = .constant
    let (low, high) = text.boundingBox
    let scale: Float = 0.004
    let width = (high.x - low.x) * scale
    let height = (high.y - low.y) * scale
    let words = SCNNode(geometry: text)
    words.scale = SCNVector3(scale, scale, scale)
    words.position = SCNVector3(-width / 2 - low.x * scale, -height / 2 - low.y * scale, 0.001)

    let plate = SCNPlane(width: CGFloat(width + 0.02), height: CGFloat(height + 0.012))
    plate.cornerRadius = CGFloat(height + 0.012) / 4
    plate.firstMaterial?.diffuse.contents = UIColor.black.withAlphaComponent(0.75)
    plate.firstMaterial?.lightingModel = .constant
    let tag = SCNNode(geometry: plate)
    tag.addChildNode(words)
    tag.position = SCNVector3(0, 0.06 + height / 2, 0)
    tag.constraints = [SCNBillboardConstraint()]
    root.addChildNode(tag)

    return root
  }
}
