import * as THREE from 'three';
import type { V2 } from './geometry2d';
import type { Plan } from './navigation';
import type { Surface, SurfaceMap, V3 } from './surfaces';

const REVEAL_VERT = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    // The mesh is only lifted in y, so local x/z are the surface coordinates of the parent frame.
    vXZ = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Dot grid that sweeps out from where the companion landed, then settles to a faint trace.
const REVEAL_FRAG = /* glsl */ `
  uniform vec2 uOrigin;
  uniform float uAge;
  uniform float uSpacing;
  uniform float uSpeed;
  uniform vec3 uColor;
  varying vec2 vXZ;
  void main() {
    vec2 cell = fract(vXZ / uSpacing) - 0.5;
    float dotMask = 1.0 - smoothstep(0.08, 0.16, length(cell));
    float d = distance(vXZ, uOrigin);
    float r = uAge * uSpeed;
    float ring = exp(-pow((d - r) / (uSpacing * 1.5), 2.0));
    float inside = step(d, r);
    float fade = 0.12 + 0.5 * exp(-uAge * 1.2);
    float a = dotMask * (inside * fade + ring * 0.9) + ring * 0.12;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface SurfaceMeshes {
  version: number;
  shadow: THREE.Mesh;
  reveal: THREE.Mesh | null;
  outline: THREE.LineLoop;
  revealAge: number;
  origin: V2;
}

interface Effect {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  grow: number;
}

function hullGeometry(hull: V2[]): THREE.BufferGeometry {
  const shape = new THREE.Shape(hull.map(([x, z]) => new THREE.Vector2(x, -z)));
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

/**
 * Everything drawn on the real surfaces: invisible shadow catchers (so the companion casts a
 * shadow on tables and floors), the "discovered" reveal, tap ripples, landing dust and, in debug
 * mode, the outlines of every detected surface and the planned path.
 */
export class SurfaceView {
  readonly root = new THREE.Group();
  private readonly meshes = new Map<number, SurfaceMeshes>();
  private readonly effects: Effect[] = [];
  private pathLine: THREE.Line | null = null;
  private lastVersion = -1;
  private debug = false;
  private shadowOn = new Set<number>();
  private readonly ringGeo: THREE.RingGeometry;

  constructor(
    private readonly map: SurfaceMap,
    private readonly h: number,
    /** Draw the companion's shadow on detected surfaces (off when the surfaces are virtual). */
    private readonly catchShadows = true,
  ) {
    this.ringGeo = new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2);
  }

  /**
   * Shows the companion's shadow only on the given surfaces (where it stands, and where a jump
   * lands). Shadows don't pass through other detected surfaces, so this avoids a second shadow
   * on the floor under a table.
   */
  setShadowSurfaces(ids: number[]): void {
    this.shadowOn = new Set(ids);
    for (const [id, m] of this.meshes) m.shadow.visible = this.catchShadows && this.shadowOn.has(id);
  }

  setDebug(on: boolean): void {
    this.debug = on;
    for (const m of this.meshes.values()) m.outline.visible = on;
    if (this.pathLine) this.pathLine.visible = on;
  }

  /** Starts the reveal on a newly discovered surface from where the companion landed. */
  revealFrom(surface: Surface, at: V3): void {
    const m = this.meshes.get(surface.id);
    if (m) {
      m.revealAge = 0;
      m.origin = [at[0], at[2]];
    }
    this.lastVersion = -1; // rebuild to add the reveal layer
  }

  ripple(at: V3, color = 0xffffff): void {
    this.effect(at, color, 0.8, 1.2 * this.h, 0.9);
  }

  dust(at: V3, strength: number): void {
    this.effect(at, 0xd8d2c8, 0.5, (0.5 + Math.min(strength, 3) * 0.25) * this.h, 0.5);
  }

  private effect(at: V3, color: number, life: number, grow: number, opacity: number): void {
    const mesh = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    mesh.position.set(at[0], at[1] + 0.004 * this.h, at[2]);
    mesh.renderOrder = 3;
    this.root.add(mesh);
    this.effects.push({ mesh, age: 0, life, grow });
  }

  showPlan(plan: Plan | null, from: V3): void {
    if (this.pathLine) {
      this.pathLine.removeFromParent();
      this.pathLine.geometry.dispose();
      this.pathLine = null;
    }
    if (!plan) return;
    const pts: THREE.Vector3[] = [new THREE.Vector3(...from)];
    for (const s of plan.steps) {
      if (s.kind === 'walk') pts.push(new THREE.Vector3(...s.to));
      else {
        // Sketch the arc.
        for (let i = 1; i <= 8; i++) {
          const k = i / 8;
          const y = s.from[1] + (s.to[1] - s.from[1]) * k + Math.sin(Math.PI * k) * this.h * 0.8;
          pts.push(new THREE.Vector3(s.from[0] + (s.to[0] - s.from[0]) * k, y, s.from[2] + (s.to[2] - s.from[2]) * k));
        }
      }
    }
    this.pathLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }),
    );
    this.pathLine.renderOrder = 5;
    this.pathLine.visible = this.debug;
    this.root.add(this.pathLine);
  }

  update(dt: number): void {
    if (this.map.version !== this.lastVersion) {
      this.lastVersion = this.map.version;
      this.sync();
    }
    for (const m of this.meshes.values()) {
      if (!m.reveal) continue;
      m.revealAge += dt;
      const u = (m.reveal.material as THREE.ShaderMaterial).uniforms;
      u.uAge.value = m.revealAge;
      u.uOrigin.value.set(m.origin[0], m.origin[1]);
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += dt;
      const k = e.age / e.life;
      e.mesh.scale.setScalar(0.1 * this.h + e.grow * k);
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
      if (k >= 1) {
        e.mesh.removeFromParent();
        (e.mesh.material as THREE.Material).dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  /** Rebuilds the meshes of surfaces whose outline changed. */
  private sync(): void {
    const alive = new Set<number>();
    for (const s of this.map.surfaces) {
      if (!s.confirmed || s.hull.length < 3) continue;
      alive.add(s.id);
      let m = this.meshes.get(s.id);
      if (m && m.version === s.version && (!!m.reveal === s.discovered)) continue;
      const geo = hullGeometry(s.hull);
      const lift = 0.002 * this.h;
      if (!m) {
        const shadow = new THREE.Mesh(geo, new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false }));
        shadow.receiveShadow = true;
        shadow.renderOrder = 1;
        shadow.visible = this.catchShadows && this.shadowOn.has(s.id);
        const outline = new THREE.LineLoop(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }),
        );
        outline.visible = this.debug;
        outline.renderOrder = 4;
        this.root.add(shadow, outline);
        m = { version: -1, shadow, reveal: null, outline, revealAge: 99, origin: [0, 0] };
        this.meshes.set(s.id, m);
      } else {
        m.shadow.geometry.dispose();
        m.shadow.geometry = geo;
      }
      m.shadow.position.y = s.y + lift;
      m.outline.geometry.dispose();
      m.outline.geometry = new THREE.BufferGeometry().setFromPoints(s.hull.map(([x, z]) => new THREE.Vector3(x, s.y + 2 * lift, z)));
      (m.outline.material as THREE.LineBasicMaterial).color.set(s.discovered ? 0x00ffd5 : 0xffd23f);
      if (s.discovered) {
        if (!m.reveal) {
          m.reveal = new THREE.Mesh(
            geo,
            new THREE.ShaderMaterial({
              vertexShader: REVEAL_VERT,
              fragmentShader: REVEAL_FRAG,
              uniforms: {
                uOrigin: { value: new THREE.Vector2(m.origin[0], m.origin[1]) },
                uAge: { value: m.revealAge },
                uSpacing: { value: 0.35 * this.h },
                uSpeed: { value: 4 * this.h },
                uColor: { value: new THREE.Color(0x00ffd5) },
              },
              transparent: true,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          m.reveal.renderOrder = 2;
          this.root.add(m.reveal);
        } else {
          m.reveal.geometry = geo;
        }
        m.reveal.position.y = s.y + 1.5 * lift;
      }
      m.version = s.version;
    }
    for (const [id, m] of this.meshes) {
      if (alive.has(id)) continue;
      m.shadow.removeFromParent();
      m.outline.removeFromParent();
      m.reveal?.removeFromParent();
      this.meshes.delete(id);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
