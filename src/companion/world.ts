import * as THREE from 'three';
import { CompanionBrain } from './brain';
import { CompanionCharacter, RUN_SPEED, WALK_SPEED, loadCompanionModel } from './character';
import type { V2 } from './geometry2d';
import { navParamsFor, type Plan } from './navigation';
import { SurfaceMap, type V3 } from './surfaces';
import { SurfaceView } from './surfaceView';

export const COMPANION_MODEL_URL = `${import.meta.env.BASE_URL}models/RobotExpressive.glb`;

export interface CompanionWorldOptions {
  /** Object the companion lives in; its local frame must be y-up. */
  parent: THREE.Object3D;
  /** Size of one world unit in metres (1 in WebXR, the code's side in camera tracking). */
  metersPerUnit: number;
  /** Companion height in world units. */
  height: number;
  /** Where it appears: the centre of the virtual QR code. */
  spawn: V3;
  /** Initial outline of the surface it appears on (world x/z). */
  spawnSurface: V2[];
  /** Draw the companion's shadow on detected surfaces (default true; off for virtual rooms). */
  catchShadows?: boolean;
  onDiscovered?(count: number): void;
}

/**
 * Glue between the surface map, the companion's brain, the rendered character and the surface
 * visuals. Feed it surface observations and taps; call update() every frame.
 */
export class CompanionWorld {
  readonly map: SurfaceMap;
  readonly brain: CompanionBrain;
  readonly view: SurfaceView;
  private readonly character: CompanionCharacter;
  private readonly light: THREE.DirectionalLight;
  private readonly cam = new THREE.Vector3();
  private discoveredCount = 1;

  static async create(opt: CompanionWorldOptions): Promise<CompanionWorld> {
    const gltf = await loadCompanionModel(COMPANION_MODEL_URL);
    return new CompanionWorld(opt, new CompanionCharacter(gltf, opt.height));
  }

  private constructor(
    private readonly opt: CompanionWorldOptions,
    character: CompanionCharacter,
  ) {
    const m = opt.metersPerUnit;
    const h = opt.height;
    this.map = new SurfaceMap({ heightTolerance: 0.035 / m, joinDistance: 0.25 / m, minArea: 0.015 / (m * m), minHits: 5 });
    const start = this.map.addPolygon('spawn', opt.spawn[1], opt.spawnSurface)!;
    start.discovered = true;
    this.view = new SurfaceView(this.map, h, opt.catchShadows ?? true);
    this.brain = new CompanionBrain(
      this.map,
      { pos: opt.spawn, surface: start.id },
      {
        height: h,
        nav: navParamsFor(h),
        gravity: 9.81 / m,
        walkSpeed: WALK_SPEED * h,
        runSpeed: RUN_SPEED * h,
        events: {
          discovered: (s) => {
            this.view.revealFrom(s, this.brain.pos);
            this.opt.onDiscovered?.(++this.discoveredCount);
          },
          landed: (p, impact) => this.view.dust(p, impact),
          plan: (plan) => this.view.showPlan(plan, this.brain.pos),
        },
      },
    );
    this.character = character;

    // Key light that follows the companion so its shadow map stays sharp at any room size.
    this.light = new THREE.DirectionalLight(0xffffff, 2.2);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(1024, 1024);
    const c = this.light.shadow.camera;
    c.left = c.bottom = -2.5 * h;
    c.right = c.top = 2.5 * h;
    c.near = 0.1 * h;
    c.far = 12 * h;
    this.light.shadow.bias = -0.0005;
    this.light.shadow.normalBias = 0.02 * h;
    this.light.shadow.radius = 4;
    opt.parent.add(this.view.root, this.character.root, this.light, this.light.target);
  }

  /** Feeds a hit on a real surface (point and its normal, in the parent's frame). */
  addHit(p: V3, normal: V3): void {
    this.map.addHit(p, normal);
  }

  /** Feeds a detected plane polygon (horizontal, world x/z at height y). */
  addPlane(key: unknown, y: number, polygon: V2[]): void {
    this.map.addPolygon(key, y, polygon);
  }

  /**
   * The user tapped `point` on a real surface (with that surface's normal, when known). The
   * companion makes its way there; returns the plan (null when it has nowhere to go).
   */
  goTo(point: V3, normal?: V3): Plan | null {
    // A tap that hit a surface is fresh evidence of it, even where mapping hasn't reached yet.
    if (normal) this.map.addPatch(point, normal, 0.4 * this.opt.height);
    // Taps slightly off a known outline (or on a wall) go to the closest walkable spot.
    const near = this.map.nearest(point);
    const close = near && near.distance < 0.3 / this.opt.metersPerUnit;
    const target: V3 = close ? near.point : point;
    this.view.ripple(target, 0x00ffd5);
    return this.brain.goTo(target, close ? near.surface.id : undefined);
  }

  setDebug(on: boolean): void {
    this.view.setDebug(on);
  }

  /** `camera`: camera position in the parent's frame. */
  update(dt: number, camera: THREE.Vector3): void {
    this.cam.copy(camera);
    this.brain.update(dt, [camera.x, camera.y, camera.z]);
    this.character.update(dt, this.brain, this.opt.parent.localToWorld(this.cam.clone()));
    const ids = [this.brain.surface];
    const landing = this.brain.landingSurface;
    if (landing !== null) ids.push(landing);
    this.view.setShadowSurfaces(ids);
    this.view.update(dt);
    // A phone is held well above the floor: anything 1 m below it is floor level.
    this.map.floorBelow = camera.y - 1 / this.opt.metersPerUnit;
    const h = this.opt.height;
    const p = this.brain.pos;
    this.light.target.position.set(p[0], p[1], p[2]);
    this.light.position.set(p[0] + 1.5 * h, p[1] + 5 * h, p[2] + 2 * h);
  }

  dispose(): void {
    this.character.dispose();
    this.view.dispose();
    this.light.removeFromParent();
    this.light.target.removeFromParent();
    this.light.dispose();
  }
}
