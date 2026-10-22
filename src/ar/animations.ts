import * as THREE from 'three';
import { glowTexture, qrModules, shadowTexture } from './textures';

/**
 * AR animations. Every animation lives in "content space": the virtual QR code is the square
 * x, z in [-0.5, 0.5] on the y = 0 plane, y points up out of the surface, and P1 (the first pin)
 * is the corner (-0.5, 0, -0.5). One unit = the side of the virtual QR code.
 */
export interface ARAnimation {
  readonly object: THREE.Object3D;
  update(time: number, dt: number): void;
  dispose(): void;
}

export interface AnimationDef {
  id: string;
  label: string;
  icon: string;
  create(): ARAnimation;
}

let sharedGlow: THREE.Texture | null = null;
let sharedShadow: THREE.Texture | null = null;
const glow = () => (sharedGlow ??= glowTexture());
const shadow = () => (sharedShadow ??= shadowTexture());

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function contactShadow(size: number, opacity = 1): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: shadow(), transparent: true, depthWrite: false, opacity }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  m.renderOrder = 1;
  return m;
}

const additive = (color: THREE.ColorRepresentation, opacity = 1) =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

/* ------------------------------------------------------------------ Hologram */

function hologram(): ARAnimation {
  const root = new THREE.Group();
  const cyan = new THREE.Color(0x00ffd5);

  const baseRing = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.36, 64), additive(cyan, 0.9));
  baseRing.rotation.x = -Math.PI / 2;
  baseRing.position.y = 0.004;
  const innerRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.215, 6), additive(0x66aaff, 0.9));
  innerRing.rotation.x = -Math.PI / 2;
  innerRing.position.y = 0.005;

  const beamGeo = new THREE.CylinderGeometry(0.14, 0.34, 0.75, 48, 1, true);
  beamGeo.translate(0, 0.375, 0);
  // Fade the beam towards the top with vertex colors.
  const colors: number[] = [];
  const pos = beamGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const k = 1 - pos.getY(i) / 0.75;
    colors.push(cyan.r * k, cyan.g * k, cyan.b * k);
  }
  beamGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );

  const gem = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.17, 0),
    new THREE.MeshStandardMaterial({
      color: 0x112233,
      emissive: 0x00aa99,
      emissiveIntensity: 0.6,
      metalness: 0.6,
      roughness: 0.2,
      flatShading: true,
    }),
  );
  const wire = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.24, 1)),
    new THREE.LineBasicMaterial({ color: cyan, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
  );
  gem.add(core, wire);
  gem.position.y = 0.6;

  const scanRings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.006, 8, 64), additive(cyan, 0.8));
    r.rotation.x = Math.PI / 2;
    scanRings.push(r);
    root.add(r);
  }
  root.add(contactShadow(0.7, 0.8), baseRing, innerRing, beam, gem);

  return {
    object: root,
    update(t) {
      baseRing.rotation.z = t * 0.6;
      innerRing.rotation.z = -t * 1.2;
      gem.position.y = 0.6 + Math.sin(t * 2) * 0.05;
      core.rotation.set(t * 0.7, t * 1.1, 0);
      wire.rotation.set(-t * 0.4, -t * 0.6, t * 0.2);
      scanRings.forEach((r, i) => {
        const p = (t * 0.45 + i / 3) % 1;
        r.position.y = p * 0.8;
        const s = 1 - p * 0.55;
        r.scale.set(s, s, s);
        (r.material as THREE.MeshBasicMaterial).opacity = Math.sin(p * Math.PI) * 0.9;
      });
    },
    dispose: () => disposeTree(root),
  };
}

/* ------------------------------------------------------------------ QR wave */

function qrWave(): ARAnimation {
  const root = new THREE.Group();
  const modules = qrModules();
  const n = modules.length;
  const cells: { x: number; z: number; finder: boolean; d: number }[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y][x]) continue;
      const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      const cx = -0.5 + (x + 0.5) / n;
      const cz = -0.5 + (y + 0.5) / n;
      cells.push({ x: cx, z: cz, finder, d: Math.hypot(cx, cz) });
    }
  }
  const size = 1 / n;
  const geo = new THREE.BoxGeometry(size * 0.9, 1, size * 0.9);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 });
  const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
  const color = new THREE.Color();
  cells.forEach((c, i) => {
    if (c.finder) color.set(0x00ffd5);
    else color.setHSL(0.6 + c.d * 0.35, 0.8, 0.55);
    mesh.setColorAt(i, color);
  });
  root.add(mesh);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();

  return {
    object: root,
    update(t) {
      cells.forEach((c, i) => {
        const wave = Math.sin(t * 3 - c.d * 14);
        const h = c.finder ? 0.06 + 0.04 * Math.sin(t * 4) : 0.02 + Math.max(0, wave) * 0.22;
        p.set(c.x, 0, c.z);
        s.set(1, h, 1);
        m4.compose(p, q, s);
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose: () => disposeTree(root),
  };
}

/* ------------------------------------------------------------------ Particle fountain */

function fountain(): ARAnimation {
  const root = new THREE.Group();
  const count = 900;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 0.045,
      map: glow(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  points.frustumCulled = false;
  const col = new THREE.Color();
  const spawn = (i: number, t: number) => {
    const a = Math.random() * Math.PI * 2;
    const spread = Math.random() * 0.25;
    positions[3 * i] = Math.cos(a) * 0.02;
    positions[3 * i + 1] = 0.02;
    positions[3 * i + 2] = Math.sin(a) * 0.02;
    vel[3 * i] = Math.cos(a) * spread;
    vel[3 * i + 1] = 1.4 + Math.random() * 0.5;
    vel[3 * i + 2] = Math.sin(a) * spread;
    life[i] = 0;
    col.setHSL((t * 0.08 + Math.random() * 0.15) % 1, 0.9, 0.6);
    colors[3 * i] = col.r;
    colors[3 * i + 1] = col.g;
    colors[3 * i + 2] = col.b;
  };
  for (let i = 0; i < count; i++) {
    spawn(i, 0);
    life[i] = -Math.random() * 1.6; // stagger the start
    positions[3 * i + 1] = -10;
  }
  const nozzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.09, 0.05, 32),
    new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.8, roughness: 0.3 }),
  );
  nozzle.position.y = 0.025;
  const pool = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.42, 64), additive(0x3366ff, 0.25));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.003;
  root.add(pool, nozzle, points);

  return {
    object: root,
    update(t, dt) {
      const g = -3.2;
      for (let i = 0; i < count; i++) {
        life[i] += dt;
        if (life[i] < 0) continue;
        if (positions[3 * i + 1] < 0 && life[i] > 0.1) {
          spawn(i, t);
          continue;
        }
        vel[3 * i + 1] += g * dt;
        positions[3 * i] += vel[3 * i] * dt;
        positions[3 * i + 1] += vel[3 * i + 1] * dt;
        positions[3 * i + 2] += vel[3 * i + 2] * dt;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      (pool.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.08 * Math.sin(t * 6);
    },
    dispose: () => disposeTree(root),
  };
}

/* ------------------------------------------------------------------ Solar system */

function solar(): ARAnimation {
  const root = new THREE.Group();
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33 }),
  );
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glow(), color: 0xffaa00, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.scale.set(0.45, 0.45, 1);
  const light = new THREE.PointLight(0xffeeaa, 3, 3, 1.5);
  const system = new THREE.Group();
  system.position.y = 0.38;
  system.add(sun, halo, light);

  const planets = [
    { r: 0.18, size: 0.025, color: 0xaaaaaa, speed: 2.2, tilt: 0.1 },
    { r: 0.27, size: 0.04, color: 0x44aaff, speed: 1.4, tilt: -0.15 },
    { r: 0.38, size: 0.035, color: 0xff6644, speed: 0.9, tilt: 0.2 },
    { r: 0.5, size: 0.06, color: 0xddbb88, speed: 0.55, tilt: -0.08, ring: true },
  ].map((p) => {
    const pivot = new THREE.Group();
    pivot.rotation.x = p.tilt;
    const orbit = new THREE.Mesh(new THREE.RingGeometry(p.r - 0.002, p.r + 0.002, 96), additive(0xffffff, 0.25));
    orbit.rotation.x = -Math.PI / 2;
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(p.size, 24, 12),
      new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.7 }),
    );
    if (p.ring) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(p.size * 1.4, p.size * 2.1, 48), additive(0xeeddaa, 0.5));
      ring.rotation.x = -Math.PI / 2.6;
      planet.add(ring);
    }
    pivot.add(orbit, planet);
    system.add(pivot);
    return { ...p, planet, phase: Math.random() * Math.PI * 2 };
  });

  const stars = new THREE.BufferGeometry();
  const sp: number[] = [];
  for (let i = 0; i < 150; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(0.55 + Math.random() * 0.25);
    sp.push(v.x, Math.abs(v.y) * 0.8 + 0.05, v.z);
  }
  stars.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const starPoints = new THREE.Points(
    stars,
    new THREE.PointsMaterial({ size: 0.015, map: glow(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  root.add(contactShadow(0.9, 0.6), system, starPoints);

  return {
    object: root,
    update(t) {
      sun.rotation.y = t * 0.3;
      halo.material.opacity = 0.75 + 0.2 * Math.sin(t * 3);
      for (const p of planets) {
        const a = p.phase + t * p.speed;
        p.planet.position.set(Math.cos(a) * p.r, 0, Math.sin(a) * p.r);
        p.planet.rotation.y = t * 2;
      }
      starPoints.rotation.y = t * 0.05;
    },
    dispose: () => disposeTree(root),
  };
}

/* ------------------------------------------------------------------ Fireworks */

function fireworks(): ARAnimation {
  const root = new THREE.Group();
  const max = 1500;
  const positions = new Float32Array(max * 3);
  const colors = new Float32Array(max * 3);
  const vel = new Float32Array(max * 3);
  const life = new Float32Array(max).fill(-1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.04,
    map: glow(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  root.add(points);
  for (let i = 0; i < max; i++) positions[3 * i + 1] = -10;

  interface Rocket { pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; hue: number; mesh: THREE.Mesh }
  const rockets: Rocket[] = [];
  const rocketGeo = new THREE.SphereGeometry(0.015, 8, 6);
  let next = 0;
  let cursor = 0;
  const col = new THREE.Color();
  const launcher = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.08, 32), additive(0xffaa33, 0.8));
  launcher.rotation.x = -Math.PI / 2;
  launcher.position.y = 0.003;
  root.add(launcher);

  const explode = (r: Rocket) => {
    const n = 140;
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % max;
      const d = new THREE.Vector3().randomDirection().multiplyScalar(0.35 + Math.random() * 0.15);
      positions.set([r.pos.x, r.pos.y, r.pos.z], 3 * i);
      vel.set([d.x, d.y, d.z], 3 * i);
      life[i] = 1.4 + Math.random() * 0.4;
      col.setHSL((r.hue + Math.random() * 0.08) % 1, 1, 0.6);
      colors.set([col.r, col.g, col.b], 3 * i);
    }
  };

  return {
    object: root,
    update(t, dt) {
      if (t > next) {
        next = t + 0.7 + Math.random() * 0.6;
        const mesh = new THREE.Mesh(rocketGeo, new THREE.MeshBasicMaterial({ color: 0xffeeaa }));
        const r: Rocket = {
          pos: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3),
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.2, 1.6 + Math.random() * 0.4, (Math.random() - 0.5) * 0.2),
          fuse: 0.55 + Math.random() * 0.2,
          hue: Math.random(),
          mesh,
        };
        rockets.push(r);
        root.add(mesh);
      }
      for (let k = rockets.length - 1; k >= 0; k--) {
        const r = rockets[k];
        r.vel.y -= 1.2 * dt;
        r.pos.addScaledVector(r.vel, dt);
        r.mesh.position.copy(r.pos);
        r.fuse -= dt;
        if (r.fuse <= 0) {
          explode(r);
          root.remove(r.mesh);
          (r.mesh.material as THREE.Material).dispose();
          rockets.splice(k, 1);
        }
      }
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) {
          if (life[i] > -1) {
            positions[3 * i + 1] = -10;
            life[i] = -1;
          }
          continue;
        }
        life[i] -= dt;
        vel[3 * i + 1] -= 0.6 * dt;
        const drag = 1 - 1.2 * dt;
        vel[3 * i] *= drag;
        vel[3 * i + 1] *= drag;
        vel[3 * i + 2] *= drag;
        positions[3 * i] += vel[3 * i] * dt;
        positions[3 * i + 1] += vel[3 * i + 1] * dt;
        positions[3 * i + 2] += vel[3 * i + 2] * dt;
        if (life[i] < 0.8) {
          const fade = Math.max(0, 1 - 2.5 * dt);
          colors[3 * i] *= fade;
          colors[3 * i + 1] *= fade;
          colors[3 * i + 2] *= fade;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      launcher.rotation.z = t;
    },
    dispose() {
      rocketGeo.dispose();
      disposeTree(root);
    },
  };
}

export const ANIMATIONS: AnimationDef[] = [
  { id: 'hologram', label: 'Hologram', icon: '💠', create: hologram },
  { id: 'qrwave', label: 'QR Wave', icon: '🔳', create: qrWave },
  { id: 'fountain', label: 'Fountain', icon: '⛲', create: fountain },
  { id: 'solar', label: 'Solar', icon: '🪐', create: solar },
  { id: 'fireworks', label: 'Fireworks', icon: '🎆', create: fireworks },
];
