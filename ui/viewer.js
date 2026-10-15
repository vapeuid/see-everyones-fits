'use strict';
// Tiny WebGL viewer for the one-mesh .glb files lib/format writes (positions, normals, UV0, indices, one PNG texture).
// Drag to turn, wheel / pinch to zoom. No dependencies.
(function () {
  const VS = `attribute vec3 p; attribute vec3 n; attribute vec2 uv;
    uniform mat4 mvp; uniform mat4 model; varying vec3 vn; varying vec2 vuv;
    void main() { vn = mat3(model) * n; vuv = uv; gl_Position = mvp * vec4(p, 1.0); }`;
  const FS = `precision mediump float; varying vec3 vn; varying vec2 vuv; uniform sampler2D tex; uniform float hasTex;
    void main() {
      vec3 N = normalize(vn); if (!gl_FrontFacing) N = -N;
      vec3 base = hasTex > 0.5 ? texture2D(tex, vuv).rgb : vec3(0.78, 0.76, 0.8);
      float key = max(dot(N, normalize(vec3(0.45, 0.75, 0.6))), 0.0);
      float rim = max(dot(N, normalize(vec3(-0.6, 0.3, -0.7))), 0.0);
      gl_FragColor = vec4(base * (0.38 + 0.72 * key) + vec3(1.0, 0.55, 0.35) * rim * 0.25, 1.0);
    }`;

  // ---- 4x4 matrices (column-major, as WebGL wants)
  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const persp = (fov, asp, near, far) => { const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far); return new Float32Array([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]); };
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); };
  const trans = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const scale = (s) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);

  function parseGlb(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb file');
    const jsonLen = dv.getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    const binStart = 20 + jsonLen + 8;
    const TYPES = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array };
    const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const acc = (i) => { const a = gltf.accessors[i], v = gltf.bufferViews[a.bufferView], T = TYPES[a.componentType]; return { data: new T(buf, binStart + (v.byteOffset || 0) + (a.byteOffset || 0), a.count * SIZE[a.type]), min: a.min, max: a.max }; };
    const prim = gltf.meshes[0].primitives[0], at = prim.attributes;
    const out = { pos: acc(at.POSITION), nrm: at.NORMAL != null ? acc(at.NORMAL).data : null, uv: at.TEXCOORD_0 != null ? acc(at.TEXCOORD_0).data : null, idx: acc(prim.indices).data, image: null };
    if (gltf.images && gltf.images[0]) { const v = gltf.bufferViews[gltf.images[0].bufferView]; out.image = new Blob([new Uint8Array(buf, binStart + (v.byteOffset || 0), v.byteLength)], { type: gltf.images[0].mimeType || 'image/png' }); }
    return out;
  }

  function ModelViewer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true }) || canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('this browser has no WebGL');
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (!gl2) gl.getExtension('OES_element_index_uint');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    const loc = { p: gl.getAttribLocation(prog, 'p'), n: gl.getAttribLocation(prog, 'n'), uv: gl.getAttribLocation(prog, 'uv'), mvp: gl.getUniformLocation(prog, 'mvp'), model: gl.getUniformLocation(prog, 'model'), tex: gl.getUniformLocation(prog, 'tex'), hasTex: gl.getUniformLocation(prog, 'hasTex') };
    let mesh = null, yaw = 0.6, pitch = 0.2, dist = 2.4, spin = true, raf = 0, alive = true;

    const buffer = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    function draw() {
      raf = 0; if (!alive || !mesh) return;
      const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
      if (spin) yaw += 0.006;
      const model = mul(rotX(pitch), mul(rotY(yaw), mesh.fit));
      const mvp = mul(persp(0.7, canvas.width / Math.max(1, canvas.height), 0.05, 50), mul(trans(0, 0, -dist), model));
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.mvp, false, mvp); gl.uniformMatrix4fv(loc.model, false, model);
      const attr = (l, b, size) => { if (l < 0) return; if (!b) { gl.disableVertexAttribArray(l); return; } gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); };
      attr(loc.p, mesh.p, 3); attr(loc.n, mesh.n, 3); attr(loc.uv, mesh.uv, 2);
      if (loc.n >= 0 && !mesh.n) gl.vertexAttrib3f(loc.n, 0, 1, 0);
      if (loc.uv >= 0 && !mesh.uv) gl.vertexAttrib2f(loc.uv, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mesh.tex); gl.uniform1i(loc.tex, 0); gl.uniform1f(loc.hasTex, mesh.tex ? 1 : 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.i);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
      if (spin) raf = requestAnimationFrame(draw);
    }
    const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };

    // drag to turn, wheel to zoom
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; spin = false; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (!drag) return; yaw += (e.clientX - drag.x) * 0.01; pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - drag.y) * 0.01)); drag = { x: e.clientX, y: e.clientY }; redraw(); });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(0.8, Math.min(8, dist * (e.deltaY > 0 ? 1.1 : 0.9))); redraw(); }, { passive: false });

    return {
      async load(url) {
        const r = await fetch(url); if (!r.ok) throw new Error('preview file missing');
        const g = parseGlb(await r.arrayBuffer());
        const mn = g.pos.min, mx = g.pos.max, ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
        const fit = mul(scale(1.4 / ext), trans(-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -(mn[2] + mx[2]) / 2));
        let tex = null;
        if (g.image && g.uv) {
          const bmp = await createImageBitmap(g.image);
          tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          const pow2 = (v) => (v & (v - 1)) === 0;
          if (gl2 || (pow2(bmp.width) && pow2(bmp.height))) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
          else { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
        }
        mesh = { p: buffer(gl.ARRAY_BUFFER, g.pos.data), n: g.nrm ? buffer(gl.ARRAY_BUFFER, g.nrm) : null, uv: g.uv ? buffer(gl.ARRAY_BUFFER, g.uv) : null, i: buffer(gl.ELEMENT_ARRAY_BUFFER, g.idx), count: g.idx.length, big: g.idx instanceof Uint32Array, tex, fit };
        yaw = 0.6; pitch = 0.2; dist = 2.4; spin = true; redraw();
        return { triangles: g.idx.length / 3 };
      },
      dispose() { alive = false; if (raf) cancelAnimationFrame(raf); const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); },
    };
  }
  window.ModelViewer = ModelViewer;
})();
