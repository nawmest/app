import * as THREE from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AnimName, CompanionBrain } from './brain';

/** RobotExpressive (CC0, Quaternius) measurements, in model units. */
const MODEL_HEIGHT = 4.44;
/** Ground speed of the Walking / Running cycles at normal playback, in body heights per second. */
export const WALK_SPEED = 0.767;
export const RUN_SPEED = 1.25;

const ONE_SHOT: AnimName[] = ['Jump'];
const FADE = 0.22;

let cached: Promise<GLTF> | null = null;

/** Loads the model from a URL, or decodes it directly from a base64 data: URI (single-file builds). */
export function loadCompanionModel(url: string): Promise<GLTF> {
  if (!cached) {
    const loader = new GLTFLoader();
    if (url.startsWith('data:')) {
      const bin = atob(url.slice(url.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      cached = loader.parseAsync(bytes.buffer, '');
    } else {
      cached = loader.loadAsync(url);
    }
    cached.catch(() => (cached = null));
  }
  return cached;
}

/**
 * The visible companion: the robot model, its animation mixer (cross-fading between the clips
 * the brain asks for), a head that turns to look at the user, and a facial expression in the air.
 */
export class CompanionCharacter {
  readonly root = new THREE.Group();
  private readonly model: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private readonly head: THREE.Object3D | null;
  private readonly face: THREE.Mesh | null;
  private headYaw = 0;
  private appear = 0;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(gltf: GLTF, readonly height: number) {
    // The loaded model is shared; each companion gets its own copy of the rig.
    this.model = clone(gltf.scene);
    this.model.scale.setScalar(height / MODEL_HEIGHT);
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });
    this.root.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      if (ONE_SHOT.includes(clip.name as AnimName)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.actions.set(clip.name, a);
    }
    this.head = this.model.getObjectByName('Head') ?? null;
    let face: THREE.Mesh | null = null;
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && 'Surprised' in m.morphTargetDictionary) face = m;
    });
    this.face = face;
    this.play('Idle', 1);
  }

  private play(name: string, speed: number): void {
    const next = this.actions.get(name);
    if (!next) return;
    next.timeScale = speed;
    if (this.currentName === name) return;
    next.reset().setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(next, FADE, false);
    this.current = next;
    this.currentName = name;
  }

  update(dt: number, brain: CompanionBrain, cameraPos: THREE.Vector3): void {
    // Pop in with a little overshoot when spawned.
    this.appear = Math.min(1, this.appear + dt / 0.6);
    const k = this.appear;
    const pop = k >= 1 ? 1 : 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);
    this.root.scale.setScalar(Math.max(0.001, pop));

    this.root.position.set(brain.pos[0], brain.pos[1], brain.pos[2]);
    this.root.rotation.set(0, brain.yaw, 0);
    this.play(brain.anim, brain.animSpeed);
    this.mixer.update(dt);

    if (this.face?.morphTargetDictionary && this.face.morphTargetInfluences) {
      const i = this.face.morphTargetDictionary['Surprised'];
      const target = brain.airborne ? 1 : 0;
      this.face.morphTargetInfluences[i] += (target - this.face.morphTargetInfluences[i]) * Math.min(1, dt * 10);
    }

    // Turn the head towards the user while standing around.
    if (this.head) {
      const looking = brain.anim !== 'Jump' && brain.anim !== 'Running';
      this.root.updateMatrixWorld(true);
      const local = this.root.worldToLocal(this.tmpV.copy(cameraPos));
      let rel = Math.atan2(local.x, local.z);
      rel = looking ? Math.max(-1.1, Math.min(1.1, rel)) : 0;
      this.headYaw += (rel - this.headYaw) * Math.min(1, dt * 5);
      // Rotate the animated head about the world up axis.
      const parent = this.head.parent!;
      parent.getWorldQuaternion(this.tmpQ);
      const worldHead = this.tmpQ2.copy(this.tmpQ).multiply(this.head.quaternion);
      worldHead.premultiply(new THREE.Quaternion().setFromAxisAngle(this.up, this.headYaw));
      this.head.quaternion.copy(this.tmpQ.invert().multiply(worldHead));
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
