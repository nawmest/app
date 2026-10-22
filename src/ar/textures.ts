import * as THREE from 'three';

/** Soft round sprite used by the particle systems. */
export function glowTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Radial blob used as a fake contact shadow. */
export function shadowTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/** Deterministic QR-like module pattern (21x21, version 1 layout) with the three finder patterns. */
export function qrModules(seed = 7): boolean[][] {
  const n = 21;
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const grid: boolean[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => rnd() > 0.52));
  const finder = (ox: number, oy: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const gx = ox + x;
        const gy = oy + y;
        if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        grid[gy][gx] = ring === 3 || ring <= 1;
      }
    }
  };
  finder(0, 0); // P1 - top left
  finder(n - 7, 0); // P2 - top right
  finder(0, n - 7); // P3 - bottom left
  for (let i = 8; i < n - 8; i++) grid[6][i] = grid[i][6] = i % 2 === 0; // timing patterns
  return grid;
}

/** Texture for the virtual QR code base: finder patterns at P1, P2, P3 and data modules. */
export function qrTexture(): THREE.Texture {
  const modules = qrModules();
  const n = modules.length;
  const px = 512;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const cell = px / n;
  g.clearRect(0, 0, px, px);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(0, 0, px, px);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y][x]) continue;
      const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      g.fillStyle = finder ? 'rgba(0,255,214,0.95)' : 'rgba(20,30,60,0.55)';
      g.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }
  }
  g.strokeStyle = 'rgba(0,255,214,0.9)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, px - 6, px - 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
