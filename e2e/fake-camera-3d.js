// Injected before the app loads: replaces getUserMedia with a synthetic rear camera that films a
// poster lying on a table, rendered in true 3D perspective with WebGL. The camera pose is driven
// by the test (window.__fakeCam.state.t), and the ground truth projection is exposed so the test
// can measure where 3D content should appear.
(() => {
  const W = 720;
  const H = 1280;
  // Same field of view the app assumes (67 degrees across the long side).
  const F = H / 2 / Math.tan(((67 / 2) * Math.PI) / 180);

  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const poster = () => {
    const P = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = P;
    const g = c.getContext('2d');
    g.fillStyle = '#f1ece2';
    g.fillRect(0, 0, P, P);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `hsl(${Math.floor(rnd() * 360)},${50 + rnd() * 45}%,${15 + rnd() * 65}%)`;
      const x = rnd() * P;
      const y = rnd() * P;
      const s = 10 + rnd() * 90;
      if (rnd() < 0.5) g.fillRect(x, y, s, s * (0.3 + rnd()));
      else {
        g.beginPath();
        g.arc(x, y, s / 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = '#111';
    g.font = 'bold 110px sans-serif';
    g.fillText('TRIPOINT', 150, 540);
    g.lineWidth = 14;
    g.strokeRect(7, 7, P - 14, P - 14);
    return c;
  };

  const table = () => {
    const P = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = P;
    const g = c.getContext('2d');
    g.fillStyle = '#7a5235';
    g.fillRect(0, 0, P, P);
    for (let y = 0; y < P; y += 6) {
      g.fillStyle = `rgba(${40 + rnd() * 40},${20 + rnd() * 20},0,${0.15 + rnd() * 0.3})`;
      g.fillRect(0, y, P, 2 + rnd() * 3);
    }
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.35})`;
      g.fillRect(rnd() * P, rnd() * P, 3 + rnd() * 10, 2 + rnd() * 4);
    }
    return c;
  };

  const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
  const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const mul = (a, b) => {
    const o = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    return o;
  };
  const mv = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];

  const state = { t: 0 };

  /** Camera looking down at the table (world plane z = 0, camera on the z < 0 side). */
  const pose = (t) => {
    const tilt = -0.85 + 0.2 * Math.sin(t * 0.7); // looking down at 37-60 degrees
    const orbit = 0.55 * Math.sin(t * 0.5);
    const dist = 3.2 + 0.4 * Math.sin(t * 0.3);
    const R = mul(rotX(tilt), rotY(orbit));
    const rc = mv(R, [0, 0, 0]);
    return { R, t: [-rc[0] + 0.1 * Math.sin(t), -rc[1], dist - rc[2]] };
  };
  const toCam = (p, X) => {
    const c = mv(p.R, X);
    return [c[0] + p.t[0], c[1] + p.t[1], c[2] + p.t[2]];
  };

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  const vs = `attribute vec3 cam; attribute vec2 uv; varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(${F.toFixed(4)} * cam.x / ${(W / 2).toFixed(1)}, -${F.toFixed(4)} * cam.y / ${(H / 2).toFixed(1)}, 0.0, cam.z); }`;
  const fs = `precision mediump float; uniform sampler2D tex; varying vec2 vUv; void main() { gl_FragColor = texture2D(tex, vUv); }`;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const camLoc = gl.getAttribLocation(prog, 'cam');
  const uvLoc = gl.getAttribLocation(prog, 'uv');
  const camBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  const makeTex = (img) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return t;
  };
  const posterTex = makeTex(poster());
  const tableTex = makeTex(table());

  const quad = (p, tex, half, subdiv) => {
    // Subdivided so near-camera triangles clip gracefully.
    const cams = [];
    const uvs = [];
    const n = subdiv;
    const pt = (i, j) => [-half + (2 * half * i) / n, -half + (2 * half * j) / n, 0];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
        for (const [a, b] of corners) {
          cams.push(...toCam(p, pt(a, b)));
          uvs.push(a / n, b / n);
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, camBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cams), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(camLoc);
    gl.vertexAttribPointer(camLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLES, 0, cams.length / 3);
  };

  const draw = () => {
    const p = pose(state.t);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.55, 0.6, 0.65, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    quad(p, tableTex, 6, 12);
    quad(p, posterTex, 1, 4);
    requestAnimationFrame(draw);
  };

  window.__fakeCam = {
    state,
    width: W,
    height: H,
    /** World point -> frame pixel with the current pose. */
    project(X) {
      const c = toCam(pose(state.t), X);
      return [W / 2 + (F * c[0]) / c[2], H / 2 + (F * c[1]) / c[2]];
    },
    /** Frame pixel -> point on the table plane (z = 0). */
    unproject(x, y) {
      const p = pose(state.t);
      // Ray in camera coords, intersect with the plane transformed into camera coords.
      const d = [(x - W / 2) / F, (y - H / 2) / F, 1];
      const Rt = [p.R[0], p.R[3], p.R[6], p.R[1], p.R[4], p.R[7], p.R[2], p.R[5], p.R[8]];
      const n = mv(p.R, [0, 0, 1]); // plane normal in camera coords
      const s = (n[0] * p.t[0] + n[1] * p.t[1] + n[2] * p.t[2]) / (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
      const c = [d[0] * s - p.t[0], d[1] * s - p.t[1], d[2] * s - p.t[2]];
      return mv(Rt, c);
    },
    /** Table normal (pointing away from the camera) in current camera coordinates. */
    normal() {
      return mv(pose(state.t).R, [0, 0, 1]);
    },
  };

  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => {
    requestAnimationFrame(draw);
    return canvas.captureStream(30);
  };
})();
