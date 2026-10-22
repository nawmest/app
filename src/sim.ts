import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ARScene } from './ar/scene';
import { qrFrameFromPoints, type QRFrame } from './ar/qrFrame';
import type { Vec3 } from './ar/linalg';
import type { V2 } from './companion/geometry2d';
import { CompanionWorld } from './companion/world';

/**
 * A virtual room for trying the companion without AR hardware (and for automated tests).
 * It follows the WebXR flow: the "AR system" is simulated by casting rays from the camera into
 * the room every frame, exactly like the hit-test rays in WebXR mode, so surfaces are only
 * discovered once the camera has looked at them.
 */

export interface SimCallbacks {
  status(state: 'pinning' | 'tracking' | 'weak' | 'lost', text: string): void;
  hint(html: string): void;
  toast(message: string, warn?: boolean): void;
  locked(): void;
}

const PIN_NAMES = ['top-left', 'top-right', 'bottom-left'];

function woodTexture(base: string, stripe: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 256; y += 3) {
    g.fillStyle = stripe;
    g.globalAlpha = 0.08 + rnd() * 0.18;
    g.fillRect(0, y, 256, 1 + rnd() * 2);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Room in metres: floor, two walls, a table with a book stack, a stool, a crate and a shelf. */
function buildRoom(): THREE.Group {
  const room = new THREE.Group();
  const floorTex = woodTexture('#9a7b5c', '#3d2a1a');
  floorTex.repeat.set(4, 4);
  const mat = (color: number | string, map?: THREE.Texture) => new THREE.MeshStandardMaterial({ color, map, roughness: 0.8 });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y + h / 2, z);

    room.add(b);
    return b;
  };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(5, 5).rotateX(-Math.PI / 2), mat(0xffffff, floorTex));
  room.add(floor);
  box(5, 2.6, 0.1, 0, 0, -2.5, mat('#d9d4cb'));
  box(0.1, 2.6, 5, -2.5, 0, 0, mat('#cfc8bd'));
  const tableWood = mat(0xffffff, woodTexture('#b88a5a', '#4a2e14'));
  box(1.2, 0.04, 0.7, 0, 0.71, 0, tableWood);
  for (const [x, z] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.3], [0.55, 0.3]]) box(0.05, 0.71, 0.05, x, 0, z, tableWood);
  box(0.24, 0.07, 0.17, -0.3, 0.75, -0.12, mat('#3b6ea8'));
  box(0.2, 0.05, 0.15, -0.3, 0.82, -0.12, mat('#c0453a'));
  box(0.36, 0.04, 0.36, 0.95, 0.42, 0.05, mat('#2f2f33'));
  for (const [x, z] of [[0.8, -0.1], [1.1, -0.1], [0.8, 0.2], [1.1, 0.2]]) box(0.03, 0.42, 0.03, x, 0, z, mat('#555'));
  box(0.5, 0.3, 0.4, -1.2, 0, 0.6, mat(0xffffff, woodTexture('#c9a26b', '#6b4a22')));
  box(0.9, 0.03, 0.3, -0.2, 1.15, -0.95, mat('#e8e2d6'));
  return room;
}

export class Simulator {
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly room = buildRoom();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pinMeshes: THREE.Object3D[] = [];
  private pins: Vec3[] = [];
  private frame: QRFrame | null = null;
  world: CompanionWorld | null = null;
  private generation = 0;
  private down: { x: number; y: number; t: number } | null = null;
  private discovered = 1;
  private debug = false;
  private readonly lights: THREE.Object3D[] = [];
  private readonly rnd = mulberry(7);

  constructor(
    private readonly ar: ARScene,
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: SimCallbacks,
  ) {
    this.camera = ar.camera;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.6, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 4;
  }

  start(): void {
    const { ar } = this;
    ar.scene.add(this.room);
    const sun = new THREE.DirectionalLight(0xfff2e0, 1.2);
    sun.position.set(2, 3, 1.5);
    this.lights.push(sun);
    ar.scene.add(sun);
    ar.scene.background = new THREE.Color('#bfc6cc');
    this.camera.fov = 60;
    this.camera.near = 0.01;
    this.camera.position.set(1.1, 1.35, 1.6);
    this.resize();
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointerup', this.onUp);
    window.addEventListener('resize', this.resize);
    ar.renderer.setAnimationLoop(this.loop);
    this.updateUI();
  }

  setDebug(on: boolean): void {
    this.debug = on;
    this.world?.setDebug(on);
  }

  private readonly resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    Object.assign(this.canvas.style, { left: '0px', top: '0px', width: `${w}px`, height: `${h}px`, pointerEvents: 'auto' });
    this.ar.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  reset(): void {
    this.generation++;
    this.world?.dispose();
    this.world = null;
    this.frame = null;
    this.discovered = 1;
    for (const m of this.pinMeshes) m.removeFromParent();
    this.pinMeshes.length = 0;
    this.pins = [];
    this.ar.setContentMatrix(null);
    this.updateUI();
  }

  undo(): void {
    if (this.frame) {
      this.generation++;
      this.world?.dispose();
      this.world = null;
      this.frame = null;
      this.ar.setContentMatrix(null);
      for (const m of this.pinMeshes) this.ar.scene.add(m);
    }
    this.pins.pop();
    this.pinMeshes.pop()?.removeFromParent();
    this.updateUI();
  }

  private updateUI(): void {
    if (this.frame) {
      const n = this.discovered;
      this.cb.status('tracking', `Simulator · ${n} surface${n === 1 ? '' : 's'} discovered`);
      this.cb.hint(n < 2 ? 'Tap anywhere to call your companion. Drag to look around the room.' : '');
      return;
    }
    this.cb.status('pinning', `Pin ${this.pins.length + 1} of 3`);
    this.cb.hint(`Tap the <b>${PIN_NAMES[this.pins.length]}</b> corner of a square on a surface. Drag to look around.`);
  }

  private readonly onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private readonly onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 500) return;
    const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    this.tapAt(ndc);
  };

  /** Handles a tap at normalised device coordinates. */
  tapAt(ndc: THREE.Vector2): void {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.room, true)[0];
    if (!hit?.face) return;
    const p: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (this.frame) {
      this.world?.goTo(p, [n.x, n.y, n.z]);
      return;
    }
    if (n.y < 0.9) {
      this.cb.toast('Pick a flat, horizontal surface for the code.', true);
      return;
    }
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.018, 0.026, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x00ffd5, depthTest: false }),
    );
    marker.position.set(p[0], p[1] + 0.002, p[2]);
    marker.renderOrder = 10;
    this.ar.scene.add(marker);
    this.pinMeshes.push(marker);
    this.pins.push(p);
    if (this.pins.length === 3) this.lock();
    else this.updateUI();
  }

  /** Moves the camera around the orbit target (used by tests). */
  orbitTo(azimuth: number, polar: number, distance: number, target?: Vec3): void {
    const t = this.controls.target;
    if (target) t.set(...target);
    this.camera.position.set(
      t.x + distance * Math.sin(polar) * Math.sin(azimuth),
      t.y + distance * Math.cos(polar),
      t.z + distance * Math.sin(polar) * Math.cos(azimuth),
    );
    this.camera.lookAt(t);
  }

  /** Taps the projection of a world point (used by tests). */
  tapWorld(p: Vec3): void {
    const v = new THREE.Vector3(...p).project(this.camera);
    this.tapAt(new THREE.Vector2(v.x, v.y));
  }

  private lock(): void {
    const frame = qrFrameFromPoints(this.pins[0], this.pins[1], this.pins[2], [0, 1, 0]);
    if (!frame || frame.side < 0.03) {
      this.cb.toast('Those points are too close together or in a line. Spread them out.', true);
      this.undo();
      return;
    }
    this.frame = frame;
    this.ar.setContentMatrix(frame.matrix);
    for (const m of this.pinMeshes) m.removeFromParent();
    this.cb.locked();
    this.updateUI();
    this.spawn(frame);
  }

  private async spawn(frame: QRFrame): Promise<void> {
    const gen = ++this.generation;
    const m = new THREE.Matrix4().fromArray(frame.matrix);
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    const outline: V2[] = [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]].map(([x, z]) => {
      const v = new THREE.Vector3(x, 0, z).applyMatrix4(m);
      return [v.x, v.z] as V2;
    });
    const world = await CompanionWorld.create({
      parent: this.ar.scene,
      metersPerUnit: 1,
      height: Math.max(0.08, Math.min(0.3, 0.8 * frame.side)),
      spawn: [c.x, c.y, c.z],
      spawnSurface: outline,
      onDiscovered: (n) => {
        this.discovered = n;
        this.updateUI();
      },
    });
    if (gen !== this.generation) {
      world.dispose();
      return;
    }
    this.world = world;
    world.setDebug(this.debug);
  }

  /** Simulated AR hit-tests: a few rays per frame from the camera into what it sees. */
  private sense(): void {
    const world = this.world;
    if (!world) return;
    for (let i = 0; i < 24; i++) {
      const ndc = new THREE.Vector2(this.rnd() * 1.6 - 0.8, this.rnd() * 1.6 - 0.8);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObject(this.room, true)[0];
      if (!hit?.face || hit.distance > 4) continue;
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      // A little measurement noise, like a real AR system.
      world.addHit([hit.point.x, hit.point.y + (this.rnd() - 0.5) * 0.006, hit.point.z], [n.x, n.y, n.z]);
    }
  }

  private readonly loop = () => {
    this.controls.update();
    this.sense();
    this.ar.render((dt) => this.world?.update(dt, this.camera.position));
  };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
