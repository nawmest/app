import { type V2, clampInside, containsPoint, dist2, randomPointIn } from './geometry2d';
import { type NavParams, type Plan, planPath } from './navigation';
import type { Surface, SurfaceMap, V3 } from './surfaces';

export type AnimName = 'Idle' | 'Walking' | 'Running' | 'Jump' | 'Wave' | 'Yes' | 'No' | 'ThumbsUp' | 'Dance';

export interface BrainEvents {
  discovered?(surface: Surface): void;
  arrived?(reachedGoal: boolean): void;
  landed?(position: V3, impact: number): void;
  plan?(plan: Plan): void;
}

export interface BrainOptions {
  /** Companion height (world units). */
  height: number;
  nav: NavParams;
  /** Gravity in world units / s^2 (9.81 when the world is in metres). */
  gravity: number;
  /** Ground speeds that match the walk / run cycles (world units / s). */
  walkSpeed: number;
  runSpeed: number;
  random?: () => number;
  events?: BrainEvents;
}

type Action =
  | { kind: 'walk'; to: V3; run: boolean; stopShort: number }
  | { kind: 'turn'; face: V3; t: number }
  | {
      kind: 'jump';
      from: V3;
      to: V3;
      toSurface: number;
      t: number;
      prep: number;
      flight: number;
      land: number;
      vy: number;
    }
  | { kind: 'idle'; t: number; duration: number }
  | { kind: 'emote'; anim: AnimName; t: number; duration: number; face: 'camera' | null }
  | { kind: 'arrive'; reached: boolean };

const TURN_RATE = 6; // rad/s
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const yawTo = (from: V3, to: V3) => Math.atan2(to[0] - from[0], to[2] - from[2]);

/**
 * The companion's behaviour, independent of rendering: where it is, which way it faces, which
 * animation should play, and what it is doing next. It walks within a surface, jumps between
 * surfaces along planned paths with real ballistic arcs, explores newly found surfaces on its
 * own, and goes to wherever the user taps.
 */
export class CompanionBrain {
  pos: V3;
  yaw = 0;
  surface: number;
  anim: AnimName = 'Idle';
  /** Playback speed for the current animation. */
  animSpeed = 1;
  /** True while in the air during a jump. */
  airborne = false;
  /** Current user goal, if any. */
  goal: V3 | null = null;
  private queue: Action[] = [];
  private current: Action | null = null;
  private exploreCooldown = 2.5;
  private readonly rnd: () => number;

  constructor(
    private readonly map: SurfaceMap,
    start: { pos: V3; surface: number; yaw?: number },
    readonly opt: BrainOptions,
  ) {
    this.pos = [...start.pos];
    this.surface = start.surface;
    this.yaw = start.yaw ?? 0;
    this.rnd = opt.random ?? Math.random;
    this.enqueue({ kind: 'emote', anim: 'Wave', t: 0, duration: 1.8, face: 'camera' });
  }

  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  /** Surface a jump in progress lands on (null when not jumping). */
  get landingSurface(): number | null {
    return this.current?.kind === 'jump' ? this.map.resolve(this.current.toSurface) : null;
  }

  get action(): string {
    return this.current?.kind ?? 'none';
  }

  /** The user tapped `target`: go there (as close as possible) and greet. */
  goTo(target: V3, surfaceId?: number): Plan | null {
    const from = this.airborne && this.current?.kind === 'jump' ? this.current : null;
    const startPos = from ? from.to : this.pos;
    const startSurface = from ? from.toSurface : this.surface;
    const plan = planPath(this.map, { surface: startSurface, pos: startPos }, target, this.opt.nav, surfaceId);
    if (!plan) return null;
    this.goal = target;
    // A jump in progress finishes first; everything else is replaced.
    this.queue = [];
    if (!from) this.current = null;
    const run = plan.length > 4 * this.opt.height;
    plan.steps.forEach((s, i) => {
      if (s.kind === 'walk') {
        const last = i === plan.steps.length - 1;
        this.enqueue({ kind: 'walk', to: s.to, run, stopShort: last && plan.reachesGoal ? 0.45 * this.opt.height : 0 });
      } else {
        this.enqueueJump(s.from, s.to, s.toSurface);
      }
    });
    this.enqueue({ kind: 'arrive', reached: plan.reachesGoal });
    this.opt.events?.plan?.(plan);
    return plan;
  }

  update(dt: number, cameraPos: V3): void {
    dt = Math.min(dt, 0.1);
    if (!this.goal) this.exploreCooldown -= dt;
    this.followSurface(dt);
    if (!this.current) this.current = this.queue.shift() ?? null;
    if (!this.current) this.decide();
    if (!this.current) this.current = this.queue.shift() ?? null;
    const a = this.current;
    if (!a) {
      this.anim = 'Idle';
      return;
    }
    switch (a.kind) {
      case 'walk':
        this.doWalk(a, dt);
        break;
      case 'turn': {
        a.t += dt;
        this.anim = 'Idle';
        const done = this.turnTowards(yawTo(this.pos, a.face), dt);
        if (done || a.t > 1.5) this.next();
        break;
      }
      case 'jump':
        this.doJump(a, dt);
        break;
      case 'idle':
        a.t += dt;
        this.anim = 'Idle';
        this.animSpeed = 1;
        if (a.t >= a.duration) this.next();
        break;
      case 'emote':
        a.t += dt;
        this.anim = a.anim;
        this.animSpeed = 1;
        if (a.face === 'camera') this.turnTowards(yawTo(this.pos, cameraPos), dt);
        if (a.t >= a.duration) this.next();
        break;
      case 'arrive':
        this.goal = null;
        this.opt.events?.arrived?.(a.reached);
        this.next();
        this.queue.unshift(
          a.reached
            ? { kind: 'emote', anim: 'Wave', t: 0, duration: 1.8, face: 'camera' }
            : { kind: 'emote', anim: 'No', t: 0, duration: 1.6, face: 'camera' },
        );
        this.exploreCooldown = Math.max(this.exploreCooldown, 6);
        break;
    }
  }

  private next(): void {
    this.current = null;
  }

  private enqueue(a: Action): void {
    this.queue.push(a);
  }

  private enqueueJump(from: V3, to: V3, toSurface: number): void {
    const g = this.opt.gravity;
    const h = this.opt.height;
    const dy = to[1] - from[1];
    const horiz = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const peak = Math.max(0, dy) + 0.3 * h + 0.2 * horiz;
    const vy = Math.sqrt(2 * g * peak);
    const flight = vy / g + Math.sqrt((2 * (peak - dy)) / g);
    this.enqueue({ kind: 'turn', face: to, t: 0 });
    this.enqueue({ kind: 'jump', from, to, toSurface, t: 0, prep: 0.22, flight, land: 0.25, vy });
  }

  /** Autonomous behaviour when there is nothing to do. */
  private decide(): void {
    const s = this.map.get(this.surface);
    if (!s) return;
    if (this.exploreCooldown <= 0) {
      this.exploreCooldown = 5 + this.rnd() * 5;
      if (this.explore()) return;
    }
    const r = this.rnd();
    if (r < 0.5) {
      // Wander to a nearby point on the current surface.
      const h = this.opt.height;
      for (let i = 0; i < 8; i++) {
        const q = randomPointIn(s.hull, this.rnd);
        if (dist2(q, [this.pos[0], this.pos[2]]) > 3.5 * h || dist2(q, [this.pos[0], this.pos[2]]) < 0.6 * h) continue;
        const c = clampInside(s.hull, q, this.opt.nav.margin);
        this.enqueue({ kind: 'walk', to: [c[0], s.y, c[1]], run: false, stopShort: 0 });
        return;
      }
    }
    if (r > 0.93) {
      const anims: AnimName[] = ['Yes', 'ThumbsUp', 'Dance', 'Wave'];
      const anim = anims[Math.floor(this.rnd() * anims.length)];
      this.enqueue({ kind: 'emote', anim, t: 0, duration: anim === 'Dance' ? 3.3 : 1.7, face: 'camera' });
      return;
    }
    this.enqueue({ kind: 'idle', t: 0, duration: 1.2 + this.rnd() * 2.5 });
  }

  /** Heads for the nearest undiscovered surface it can reach. Returns false when there is none. */
  private explore(): boolean {
    let best: Plan | null = null;
    for (const s of this.map.confirmedSurfaces()) {
      if (s.discovered || s.id === this.surface) continue;
      let cx = 0, cz = 0;
      for (const p of s.hull) {
        cx += p[0];
        cz += p[1];
      }
      const c: V2 = clampInside(s.hull, [cx / s.hull.length, cz / s.hull.length], this.opt.nav.margin);
      const plan = planPath(this.map, { surface: this.surface, pos: this.pos }, [c[0], s.y, c[1]], this.opt.nav, s.id);
      if (plan?.reachesGoal && (!best || plan.length < best.length)) best = plan;
    }
    if (!best) return false;
    for (const st of best.steps) {
      if (st.kind === 'walk') this.enqueue({ kind: 'walk', to: st.to, run: false, stopShort: 0 });
      else this.enqueueJump(st.from, st.to, st.toSurface);
    }
    return true;
  }

  private doWalk(a: Extract<Action, { kind: 'walk' }>, dt: number): void {
    const dx = a.to[0] - this.pos[0];
    const dz = a.to[2] - this.pos[2];
    const d = Math.hypot(dx, dz);
    if (d <= Math.max(a.stopShort, 0.02 * this.opt.height)) {
      this.next();
      return;
    }
    const facing = Math.abs(angleDiff(this.yaw, Math.atan2(dx, dz)));
    this.turnTowards(Math.atan2(dx, dz), dt);
    const speed = (a.run ? this.opt.runSpeed : this.opt.walkSpeed) * (facing > 1 ? 0.25 : 1);
    const step = Math.min(d - a.stopShort * 0.999, speed * dt);
    if (step > 0) {
      this.pos[0] += (dx / d) * step;
      this.pos[2] += (dz / d) * step;
    }
    this.anim = a.run ? 'Running' : 'Walking';
    this.animSpeed = facing > 1 ? 0.6 : 1;
  }

  private doJump(a: Extract<Action, { kind: 'jump' }>, dt: number): void {
    a.t += dt;
    const total = a.prep + a.flight + a.land;
    this.anim = 'Jump';
    // Stretch the jump clip (0.71 s) over crouch + flight + landing.
    this.animSpeed = Math.max(0.35, Math.min(1.6, 0.71 / total));
    if (a.t < a.prep) return;
    const tf = a.t - a.prep;
    if (tf < a.flight) {
      this.airborne = true;
      const k = tf / a.flight;
      this.pos[0] = a.from[0] + (a.to[0] - a.from[0]) * k;
      this.pos[2] = a.from[2] + (a.to[2] - a.from[2]) * k;
      this.pos[1] = a.from[1] + a.vy * tf - 0.5 * this.opt.gravity * tf * tf;
      return;
    }
    if (this.airborne) {
      this.airborne = false;
      this.pos = [...a.to];
      this.surface = this.map.resolve(a.toSurface);
      const impact = a.vy - this.opt.gravity * a.flight;
      this.opt.events?.landed?.(this.pos, Math.abs(impact));
      const s = this.map.get(this.surface);
      if (s && !s.discovered) {
        s.discovered = true;
        this.opt.events?.discovered?.(s);
        // Celebrate a new place unless the user is waiting.
        if (!this.goal) this.queue.unshift({ kind: 'emote', anim: 'Yes', t: 0, duration: 1.7, face: 'camera' });
      }
    }
    if (a.t >= total) this.next();
  }

  /** Returns true when facing the target yaw. */
  private turnTowards(target: number, dt: number): boolean {
    const d = angleDiff(this.yaw, target);
    const step = TURN_RATE * dt;
    if (Math.abs(d) <= step) {
      this.yaw = target;
      return true;
    }
    this.yaw += Math.sign(d) * step;
    return false;
  }

  /** Keeps the companion on its (possibly refined or merged) surface. */
  private followSurface(dt: number): void {
    if (this.airborne) return;
    this.surface = this.map.resolve(this.surface);
    let s = this.map.get(this.surface);
    if (!s) {
      const n = this.map.nearest(this.pos);
      if (!n) return;
      s = n.surface;
      this.surface = s.id;
    }
    this.pos[1] += (s.y - this.pos[1]) * Math.min(1, dt * 8);
    // Don't walk off the edge if the outline changed under our feet.
    const q: V2 = [this.pos[0], this.pos[2]];
    if (s.hull.length >= 3 && !containsPoint(s.hull, q)) {
      const c = clampInside(s.hull, q, 0.1 * this.opt.height);
      this.pos[0] = c[0];
      this.pos[2] = c[1];
    }
  }
}
