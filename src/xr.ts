import * as THREE from 'three';
import type { ARScene } from './ar/scene';
import { type QRFrame, qrFrameFromPoints } from './ar/qrFrame';
import type { Vec3 } from './ar/linalg';
import type { V2 } from './companion/geometry2d';
import { CompanionWorld } from './companion/world';

/**
 * WebXR mode (Android Chrome with ARCore and other WebXR AR browsers).
 *
 * The device's own AR system tracks the camera in 3D and finds real surfaces, so each tap is
 * hit-tested against the actual surface and the three pins become true 3D points. The virtual QR
 * code is built from them in world space and, when supported, held by an XRAnchor so it stays
 * put as the AR system refines its map.
 *
 * Once the code is placed, a companion appears on it. A fan of hit-test rays (and plane
 * detection, where the browser offers it) keeps mapping the surfaces the camera sees, and taps
 * call the companion to the tapped spot.
 */

export async function xrSupported(): Promise<boolean> {
  try {
    return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'));
  } catch {
    return false;
  }
}

export interface XRCallbacks {
  status(state: 'pinning' | 'tracking' | 'weak' | 'lost', text: string): void;
  hint(html: string): void;
  toast(message: string, warn?: boolean): void;
  locked(): void;
  unlocked(): void;
  ended(): void;
}

const PIN_NAMES = ['top-left', 'top-right', 'bottom-left'];

interface Pin {
  position: Vec3;
  up: Vec3;
  mesh: THREE.Object3D;
}

function finderMarker(): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd5, side: THREE.DoubleSide, depthTest: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.026, 4, 1, Math.PI / 4), mat);
  const dot = new THREE.Mesh(new THREE.PlaneGeometry(0.016, 0.016), mat);
  ring.rotation.x = dot.rotation.x = -Math.PI / 2;
  ring.renderOrder = dot.renderOrder = 10;
  g.add(ring, dot);
  return g;
}

export class XRController {
  private session: XRSession | null = null;
  private viewerSource: XRHitTestSource | null = null;
  private transientSource: XRTransientInputHitTestSource | null = null;
  private lastViewerHit: XRHitTestResult | null = null;
  private transientHits = new Map<XRInputSource, XRHitTestResult>();
  private pins: Pin[] = [];
  private frame: QRFrame | null = null;
  private anchor: XRAnchor | null = null;
  /** Content matrix relative to the anchor at the time the code was locked. */
  private anchorOffset: THREE.Matrix4 | null = null;
  private readonly reticle: THREE.Mesh;
  private readonly tmp = new THREE.Matrix4();
  private sawSurface = false;
  private world: CompanionWorld | null = null;
  private worldGeneration = 0;
  /** Hit-test rays fanned out across the view, used to map surfaces. */
  private samplers: XRHitTestSource[] = [];
  private readonly planeTimes = new Map<XRPlane, number>();
  private debug = false;
  private discovered = 1;
  private readonly camPos = new THREE.Vector3();

  constructor(
    private readonly ar: ARScene,
    private readonly overlay: HTMLElement,
    private readonly cb: XRCallbacks,
  ) {
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.03, 0.04, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
  }

  get active(): boolean {
    return !!this.session;
  }

  async start(): Promise<void> {
    const session = await navigator.xr!.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors', 'plane-detection'],
      domOverlay: { root: this.overlay },
    });
    this.session = session;
    const renderer = this.ar.renderer;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    this.ar.scene.add(this.reticle);

    const viewer = await session.requestReferenceSpace('viewer');
    this.viewerSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    this.samplers = [];
    for (const x of [-0.35, 0, 0.35]) {
      for (const y of [-0.5, -0.2, 0.15]) {
        try {
          const ray = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x, y, z: -1, w: 0 });
          const src = await session.requestHitTestSource?.({ space: viewer, offsetRay: ray });
          if (src) this.samplers.push(src);
        } catch {
          // Fewer rays just means slower mapping.
        }
      }
    }
    try {
      this.transientSource =
        (await session.requestHitTestSourceForTransientInput?.({ profile: 'generic-touchscreen' })) ?? null;
    } catch {
      this.transientSource = null; // taps then place pins at the reticle in the centre
    }
    session.addEventListener('select', this.onSelect);
    session.addEventListener('end', this.onEnd);
    renderer.setAnimationLoop(this.onFrame);
    this.reset();
  }

  end(): void {
    this.session?.end().catch(() => {});
  }

  setDebug(on: boolean): void {
    this.debug = on;
    this.world?.setDebug(on);
  }

  private disposeWorld(): void {
    this.worldGeneration++;
    this.world?.dispose();
    this.world = null;
    this.discovered = 1;
  }

  reset(): void {
    this.disposeWorld();
    for (const p of this.pins) this.ar.scene.remove(p.mesh);
    this.pins = [];
    this.frame = null;
    this.anchor?.delete();
    this.anchor = null;
    this.anchorOffset = null;
    this.ar.setContentMatrix(null);
    this.cb.unlocked();
    this.updateUI();
  }

  undo(): void {
    if (this.frame) {
      this.disposeWorld();
      this.frame = null;
      this.anchorOffset = null;
      this.ar.setContentMatrix(null);
      this.cb.unlocked();
      for (const p of this.pins) this.ar.scene.add(p.mesh);
    }
    const p = this.pins.pop();
    if (p) this.ar.scene.remove(p.mesh);
    if (!this.pins.length) {
      this.anchor?.delete();
      this.anchor = null;
    }
    this.updateUI();
  }

  private updateUI(): void {
    if (this.frame) {
      const n = this.discovered;
      this.cb.status('tracking', `AR · ${n} surface${n === 1 ? '' : 's'} discovered`);
      this.cb.hint(n < 2 ? 'Tap anywhere to call your companion. Look around to reveal more surfaces.' : '');
      return;
    }
    const n = this.pins.length;
    if (!this.sawSurface) {
      this.cb.status('weak', 'Looking for a surface…');
      this.cb.hint('Move the phone slowly over a flat surface until a ring appears on it');
      return;
    }
    this.cb.status('pinning', `Pin ${n + 1} of 3`);
    this.cb.hint(`Tap the <b>${PIN_NAMES[n]}</b> corner (point ${n + 1}) of a square on the surface`);
  }

  private readonly onEnd = () => {
    this.disposeWorld();
    this.samplers = [];
    this.ar.renderer.setAnimationLoop(null);
    this.ar.renderer.xr.enabled = false;
    this.ar.scene.remove(this.reticle);
    for (const p of this.pins) this.ar.scene.remove(p.mesh);
    this.pins = [];
    this.frame = null;
    this.anchor = null;
    this.session = null;
    this.viewerSource = this.transientSource = null;
    this.ar.setContentMatrix(null);
    this.cb.ended();
  };

  private readonly onSelect = (e: XRInputSourceEvent) => {
    const hit = this.transientHits.get(e.inputSource) ?? this.lastViewerHit;
    const space = this.ar.renderer.xr.getReferenceSpace();
    const pose = hit && space ? hit.getPose(space) : null;
    if (this.frame) {
      // Call the companion to the tapped spot.
      if (!pose) this.cb.toast('No surface found there yet. Look at it for a moment and tap again.', true);
      else if (this.world) {
        const m = pose.transform.matrix; // y axis = surface normal
        this.world.goTo([m[12], m[13], m[14]], [m[4], m[5], m[6]]);
      }
      return;
    }
    if (this.pins.length >= 3) return;
    if (!hit || !pose) {
      this.cb.toast('No surface found there yet. Move the phone a little and tap again.', true);
      return;
    }
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const position: Vec3 = [m.elements[12], m.elements[13], m.elements[14]];
    // The hit pose's y axis is the surface normal.
    const up: Vec3 = [m.elements[4], m.elements[5], m.elements[6]];
    const mesh = finderMarker();
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(m);
    this.ar.scene.add(mesh);
    this.pins.push({ position, up, mesh });
    if (this.pins.length === 1) this.createAnchor(hit);
    navigator.vibrate?.(15);
    if (this.pins.length === 3) this.lock();
    else this.updateUI();
  };

  private createAnchor(hit: XRHitTestResult): void {
    this.anchor?.delete();
    this.anchor = null;
    hit.createAnchor?.()
      ?.then((anchor) => {
        // Ignore an anchor that resolves after the pins were cleared.
        if (!this.pins.length) {
          anchor.delete();
          return;
        }
        this.anchor = anchor;
      })
      .catch(() => {});
  }

  private lock(): void {
    const [a, b, c] = this.pins;
    const up: Vec3 = [
      (a.up[0] + b.up[0] + c.up[0]) / 3,
      (a.up[1] + b.up[1] + c.up[1]) / 3,
      (a.up[2] + b.up[2] + c.up[2]) / 3,
    ];
    const frame = qrFrameFromPoints(a.position, b.position, c.position, up);
    if (!frame || frame.side < 0.03) {
      this.cb.toast('Those points are too close together or in a line. Spread them out.', true);
      this.undo();
      return;
    }
    this.frame = frame;
    this.ar.setContentMatrix(frame.matrix);
    for (const p of this.pins) this.ar.scene.remove(p.mesh);
    this.anchorOffset = null; // measured against the anchor on the next frame
    navigator.vibrate?.([20, 40, 20]);
    this.cb.locked();
    this.updateUI();
    this.spawnCompanion(frame);
  }

  private async spawnCompanion(frame: QRFrame): Promise<void> {
    const gen = ++this.worldGeneration;
    const m = new THREE.Matrix4().fromArray(frame.matrix);
    const centre = new THREE.Vector3().setFromMatrixPosition(m);
    // The surface around the code, until mapping finds its real extent.
    const outline: V2[] = [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]].map(([x, z]) => {
      const v = new THREE.Vector3(x, 0, z).applyMatrix4(m);
      return [v.x, v.z] as V2;
    });
    try {
      const world = await CompanionWorld.create({
        parent: this.ar.scene,
        metersPerUnit: 1,
        height: Math.max(0.08, Math.min(0.3, 0.8 * frame.side)),
        spawn: [centre.x, centre.y, centre.z],
        spawnSurface: outline,
        onDiscovered: (n) => {
          this.discovered = n;
          this.updateUI();
        },
      });
      if (gen !== this.worldGeneration) {
        world.dispose();
        return;
      }
      this.world = world;
      world.setDebug(this.debug);
    } catch (e) {
      this.cb.toast(`Could not load the companion (${e instanceof Error ? e.message : e}).`, true);
    }
  }

  /** Feeds what the AR system currently sees into the companion's surface map. */
  private sense(xrFrame: XRFrame, space: XRReferenceSpace): void {
    const world = this.world;
    if (!world) return;
    for (const src of this.samplers) {
      const hit = xrFrame.getHitTestResults(src)[0];
      const pose = hit?.getPose(space);
      if (!pose) continue;
      const m = pose.transform.matrix; // column-major; y axis = surface normal
      world.addHit([m[12], m[13], m[14]], [m[4], m[5], m[6]]);
    }
    const planes = xrFrame.detectedPlanes;
    if (!planes) return;
    for (const plane of planes) {
      if (plane.orientation !== 'horizontal' || this.planeTimes.get(plane) === plane.lastChangedTime) continue;
      const pose = xrFrame.getPose(plane.planeSpace, space);
      if (!pose) continue;
      this.planeTimes.set(plane, plane.lastChangedTime);
      const pm = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const poly: V2[] = plane.polygon.map((p) => {
        const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(pm);
        return [v.x, v.z] as V2;
      });
      world.addPlane(plane, pose.transform.position.y, poly);
    }
  }

  private readonly onFrame = (_time: number, xrFrame?: XRFrame) => {
    const space = this.ar.renderer.xr.getReferenceSpace();
    if (xrFrame && space) {
      // Centre reticle: where a tap lands when the tap position itself cannot be hit-tested.
      const hits = this.viewerSource ? xrFrame.getHitTestResults(this.viewerSource) : [];
      this.lastViewerHit = hits[0] ?? null;
      const pose = this.lastViewerHit?.getPose(space);
      this.reticle.visible = !!pose && !this.frame;
      if (pose) {
        this.reticle.matrix.fromArray(pose.transform.matrix);
        if (!this.sawSurface) {
          this.sawSurface = true;
          this.updateUI();
        }
      }
      this.transientHits.clear();
      if (this.transientSource) {
        for (const r of xrFrame.getHitTestResultsForTransientInput(this.transientSource)) {
          if (r.results.length) this.transientHits.set(r.inputSource, r.results[0]);
        }
      }
      // Follow the anchor as the AR system refines its understanding of the room.
      if (this.frame && this.anchor && xrFrame.trackedAnchors?.has(this.anchor)) {
        const ap = xrFrame.getPose(this.anchor.anchorSpace, space);
        if (ap) {
          this.tmp.fromArray(ap.transform.matrix);
          if (!this.anchorOffset) {
            this.anchorOffset = this.tmp.clone().invert().multiply(new THREE.Matrix4().fromArray(this.frame.matrix));
          }
          this.ar.setContentMatrix(this.tmp.multiply(this.anchorOffset).elements);
        }
      }
    }
    if (xrFrame && space && this.world) {
      this.sense(xrFrame, space);
      const viewer = xrFrame.getViewerPose(space);
      if (viewer) this.camPos.set(viewer.transform.position.x, viewer.transform.position.y, viewer.transform.position.z);
    }
    this.ar.render((dt) => this.world?.update(dt, this.camPos));
  };
}
