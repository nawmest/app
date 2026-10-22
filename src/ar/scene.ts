import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Intrinsics, Pose } from './pose';
import { qrTexture } from './textures';

/**
 * Three.js overlay rendered on top of the camera video. The canvas covers exactly the video
 * frame, and the virtual camera uses the same intrinsics as the tracker, so a marker pose from the
 * tracker places content exactly on the pinned points.
 */
export class ARScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
  /** Marker frame: matrix set from the tracked pose every frame. */
  private readonly anchor = new THREE.Group();
  /** Content frame: centred on the virtual QR code, y up, one unit = one side of the code. */
  readonly content = new THREE.Group();
  private readonly base: THREE.Group;
  private readonly scanBar: THREE.Mesh;
  private scanStart = -10;
  private readonly timer = new THREE.Timer();
  /** Camera image drawn as the first layer, updated only with frames the tracker analysed. */
  private readonly background = new THREE.Scene();
  private readonly backgroundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private videoTexture: THREE.Texture | null = null;
  private readonly flip = new THREE.Matrix4().makeScale(1, -1, -1);
  private readonly contentFromMarker = new THREE.Matrix4().set(
    1, 0, 0, 0.5,
    0, 0, 1, 0.5,
    0, -1, 0, 0,
    0, 0, 0, 1,
  );

  private readonly markerFromContent: THREE.Matrix4;

  constructor(canvas: HTMLCanvasElement) {
    this.markerFromContent = this.contentFromMarker.clone().invert();
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Soft image-based lighting for believable shading, plus sky/ground fill.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5048, 0.9));
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.content.matrixAutoUpdate = false;
    this.content.matrix.copy(this.contentFromMarker);
    this.anchor.add(this.content);
    this.scene.add(this.anchor);

    // The virtual QR code where the companion appears.
    this.base = new THREE.Group();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: qrTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.renderOrder = 0;
    this.scanBar = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.08),
      new THREE.MeshBasicMaterial({
        color: 0x00ffd5,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.scanBar.rotation.x = -Math.PI / 2;
    this.scanBar.position.y = 0.003;
    this.base.add(plane, this.scanBar);
    this.content.add(this.base);
  }

  setVideo(video: HTMLVideoElement): void {
    if (this.videoTexture) return;
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture = tex;
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: tex, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.background.add(quad);
  }

  /** Uploads the video frame that is current right now (call when the tracker grabs it). */
  markVideoFrame(): void {
    if (this.videoTexture) this.videoTexture.needsUpdate = true;
  }

  /** Sizes the canvas (CSS pixels) and sets the projection from the tracker intrinsics. */
  configure(cssWidth: number, cssHeight: number, K: Intrinsics): void {
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.camera.fov = (2 * Math.atan(K.height / 2 / K.f) * 180) / Math.PI;
    this.camera.aspect = K.width / K.height;
    this.camera.updateProjectionMatrix();
  }

  setPose(pose: Pose | null): void {
    if (!pose) {
      this.anchor.visible = false;
      return;
    }
    const { R, t } = pose;
    const m = new THREE.Matrix4().set(
      R[0], R[3], R[6], t[0],
      R[1], R[4], R[7], t[1],
      R[2], R[5], R[8], t[2],
      0, 0, 0, 1,
    );
    this.anchor.matrix.multiplyMatrices(this.flip, m);
    this.anchor.matrixWorldNeedsUpdate = true;
    this.anchor.visible = true;
  }

  /** WebXR: places the content frame directly (column-major content -> world matrix). */
  setContentMatrix(m: ArrayLike<number> | null): void {
    if (!m) {
      this.anchor.visible = false;
      return;
    }
    this.anchor.matrix.fromArray(Array.from(m)).multiply(this.markerFromContent);
    this.anchor.matrixWorldNeedsUpdate = true;
    this.anchor.visible = true;
  }

  /**
   * Intersects the view ray through a screen point (normalised device coordinates) with the
   * surface of the virtual code (y = 0 in content space). Returns content coordinates.
   */
  rayToContentPlane(ndcX: number, ndcY: number): THREE.Vector3 | null {
    if (!this.anchor.visible) return null;
    this.scene.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const inv = this.content.matrixWorld.clone().invert();
    const r = ray.ray.applyMatrix4(inv);
    if (Math.abs(r.direction.y) < 1e-6) return null;
    const t = -r.origin.y / r.direction.y;
    return t > 0 ? r.at(t, new THREE.Vector3()) : null;
  }

  /** Camera position in content coordinates. */
  cameraInContent(target = new THREE.Vector3()): THREE.Vector3 {
    this.scene.updateMatrixWorld();
    this.camera.getWorldPosition(target);
    return this.content.worldToLocal(target);
  }

  /** True while the content frame has a pose (camera tracking) or a placement (WebXR). */
  get contentVisible(): boolean {
    return this.anchor.visible;
  }

  setBaseVisible(visible: boolean): void {
    this.base.visible = visible;
  }

  /** Plays the "scan" sweep over the virtual QR code (on lock / relocalization). */
  playScan(): void {
    this.scanStart = this.timer.getElapsed();
  }

  /** Renders a frame; `update` runs first with the frame time step (seconds). */
  render(update?: (dt: number) => void): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    update?.(dt);
    const sp = (t - this.scanStart) / 1.2;
    const bar = this.scanBar.material as THREE.MeshBasicMaterial;
    if (sp >= 0 && sp <= 1) {
      this.scanBar.position.z = -0.5 + sp;
      bar.opacity = Math.sin(sp * Math.PI) * 0.8;
    } else {
      bar.opacity = 0;
    }
    // In WebXR the system composites the camera image itself.
    const drawVideo = !!this.videoTexture && !this.renderer.xr.isPresenting;
    this.renderer.autoClear = !drawVideo;
    if (drawVideo) {
      this.renderer.clear();
      this.renderer.render(this.background, this.backgroundCamera);
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
