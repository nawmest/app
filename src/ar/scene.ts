import * as THREE from 'three';
import { ANIMATIONS, type ARAnimation } from './animations';
import type { Intrinsics, Pose } from './pose';
import { qrTexture } from './textures';

const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

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
  /** Content frame (centered on the QR square, y up). */
  private readonly content = new THREE.Group();
  private readonly base: THREE.Group;
  private readonly scanBar: THREE.Mesh;
  private animation: ARAnimation | null = null;
  private animationId = '';
  private appearStart = 0;
  private scanStart = -10;
  private readonly clock = new THREE.Clock();
  private readonly flip = new THREE.Matrix4().makeScale(1, -1, -1);
  private readonly contentFromMarker = new THREE.Matrix4().set(
    1, 0, 0, 0.5,
    0, 0, 1, 0.5,
    0, -1, 0, 0,
    0, 0, 0, 1,
  );

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.3, 1, 0.4);
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.content.matrixAutoUpdate = false;
    this.content.matrix.copy(this.contentFromMarker);
    this.anchor.add(this.content);
    this.scene.add(this.anchor);

    // The virtual QR code that serves as the base for the animations.
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
    this.content.add(this.base, sun, sun.target);
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

  get currentAnimation(): string {
    return this.animationId;
  }

  setAnimation(id: string): void {
    if (this.animation) {
      this.content.remove(this.animation.object);
      this.animation.dispose();
      this.animation = null;
    }
    const def = ANIMATIONS.find((a) => a.id === id);
    this.animationId = def?.id ?? '';
    if (!def) return;
    this.animation = def.create();
    this.content.add(this.animation.object);
    this.appearStart = this.clock.getElapsedTime();
  }

  setBaseVisible(visible: boolean): void {
    this.base.visible = visible;
  }

  /** Plays the "scan" sweep over the virtual QR code (on lock / relocalization). */
  playScan(): void {
    this.scanStart = this.clock.getElapsedTime();
    this.appearStart = this.scanStart;
  }

  render(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.getElapsedTime();
    const k = Math.min(1, (t - this.appearStart) / 0.8);
    const s = Math.max(0.001, easeOutBack(k));
    if (this.animation) {
      this.animation.object.scale.setScalar(s);
      if (this.anchor.visible) this.animation.update(t, dt);
    }
    const sp = (t - this.scanStart) / 1.2;
    const bar = this.scanBar.material as THREE.MeshBasicMaterial;
    if (sp >= 0 && sp <= 1) {
      this.scanBar.position.z = -0.5 + sp;
      bar.opacity = Math.sin(sp * Math.PI) * 0.8;
    } else {
      bar.opacity = 0;
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.setAnimation('');
    this.renderer.dispose();
  }
}
