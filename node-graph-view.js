const NG = {
  MAX_NODES: 1024,
  MAX_INPUTS: 32,
  MAX_OUTPUTS: 32,
  MAX_ARGS: 32,
  NODE_GOAL: 1,
  NODE_CODE: 2,
};

const ABI = {
  I32: 4,
  INPUT_PORT_SIZE: 12,
  OUTPUT_PORT_SIZE: 4,
  VALUE_SLOT_SIZE: 12,
  NODE_HEADER_SIZE: 32,
};
ABI.NODE_SIZE =
  ABI.NODE_HEADER_SIZE +
  NG.MAX_INPUTS * ABI.INPUT_PORT_SIZE +
  NG.MAX_OUTPUTS * ABI.OUTPUT_PORT_SIZE +
  NG.MAX_ARGS * ABI.VALUE_SLOT_SIZE;

const INFO = {
  GENERATION: 8,
  NODES: 24 + NG.MAX_NODES * ABI.I32 + ABI.I32,
};

const NODE = {
  ID: 0,
  KIND: 4,
  EXEC_STATE: 8,
  INPUT_COUNT: 20,
};

const MIN_SCALE = 0.2;
const MAX_SCALE = 3.0;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info || "shader compile failed");
  }
  return shader;
}

function createProgram(gl, vert, frag) {
  const program = gl.createProgram();
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(info || "program link failed");
  }
  return program;
}

function buildGlyphMap(meta) {
  const map = new Map();
  if (!meta || !meta.glyphs || !meta.atlas) return map;
  const aw = Number(meta.atlas.width) || 1;
  const ah = Number(meta.atlas.height) || 1;
  const em = Number(meta.atlas.size) || 1;
  const yOriginTop = meta.atlas.yOrigin === "top";

  for (const g of meta.glyphs) {
    const code = g.unicode;
    const advancePx = Number(g.advance || 0) * em;
    if (!g.planeBounds || !g.atlasBounds) {
      map.set(code, { empty: true, advancePx });
      continue;
    }

    const ab = g.atlasBounds;
    const pb = g.planeBounds;
    const left = Number(ab.left);
    const right = Number(ab.right);
    const srcBottom = Number(ab.bottom);
    const srcTop = Number(ab.top);

    const bottom = yOriginTop ? ah - srcBottom : srcBottom;
    const top = yOriginTop ? ah - srcTop : srcTop;
    const widthPx = right - left;
    const heightPx = top - bottom;

    map.set(code, {
      empty: false,
      uv: [left / aw, bottom / ah, widthPx / aw, heightPx / ah],
      widthPx,
      heightPx,
      offsetXPx: widthPx * 0.5 + widthPx * Number(pb.left),
      baselineOffsetYPx: -(heightPx * 0.5 + heightPx * Number(pb.bottom)),
      advancePx,
    });
  }

  return map;
}

class NodeGraphCanvasElement extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display:block; width:100%; height:100%; touch-action:none; }
        canvas { width:100%; height:100%; display:block; }
      </style>
      <canvas></canvas>
    `;

    this.canvas = root.querySelector("canvas");
    this.gl = null;
    this.assets = null;
    this.api = null;
    this.memory = null;
    this.dv = null;
    this.nodeLayout = new Map();

    this.lastGeneration = -1;
    this.lastSizeKey = "";

    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    this.textAtlas = null;
    this.skinTexture = null;

    this._onWheel = this._onWheel.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  connectedCallback() {
    this.gl = this.canvas.getContext("webgl2", { alpha: false, antialias: true });
    if (!this.gl) {
      this.textContent = "WebGL2 not supported";
      return;
    }
    this._initPrograms();
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    this.canvas.addEventListener("pointermove", this._onPointerMove);
    this.canvas.addEventListener("pointerup", this._onPointerUp);
    this.canvas.addEventListener("pointerleave", this._onPointerUp);
    this.canvas.addEventListener("pointercancel", this._onPointerUp);
  }

  disconnectedCallback() {
    this.canvas.removeEventListener("wheel", this._onWheel);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("pointermove", this._onPointerMove);
    this.canvas.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.removeEventListener("pointerleave", this._onPointerUp);
    this.canvas.removeEventListener("pointercancel", this._onPointerUp);
  }

  setAssets(assets) {
    this.assets = assets;
    if (this.gl) {
      this._buildNineSliceTexture();
      this._loadTextAtlasFromAssets()
        .then(() => this.requestRenderIfGenerationChanged(true))
        .catch((err) => {
          console.error("text atlas load failed", err);
        });
    }
  }

  setNodeLayoutMap(map) {
    this.nodeLayout = map;
    this.requestRenderIfGenerationChanged(true);
  }

  attachRuntime({ api, memory }) {
    this.api = api;
    this.memory = memory;
    this.dv = new DataView(memory.buffer);
    this.requestRenderIfGenerationChanged(true);
  }

  requestRenderIfGenerationChanged(force = false) {
    if (!this.gl || !this.api || !this.memory || !this.assets) return;
    const generation = this.dv.getUint32(this.api.ng_get_info_ptr() + INFO.GENERATION, true);
    const sizeKey = this._resizeCanvas();
    if (!force && generation === this.lastGeneration && sizeKey === this.lastSizeKey) return;
    this.lastGeneration = generation;
    this.lastSizeKey = sizeKey;
    this._render();
  }

  _resizeCanvas() {
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const w = Math.max(1, Math.floor(this.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return `${w}x${h}`;
  }

  _onWheel(e) {
    if (!this.gl) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (this.canvas.width / Math.max(1, rect.width));
    const y = (e.clientY - rect.top) * (this.canvas.height / Math.max(1, rect.height));

    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      this._zoomAt(x, y, factor);
    } else {
      this.offsetX -= e.deltaX;
      this.offsetY -= e.deltaY;
      this.requestRenderIfGenerationChanged(true);
    }
  }

  _onPointerDown(e) {
    this.isDragging = true;
    this.dragStartX = e.clientX - this.offsetX;
    this.dragStartY = e.clientY - this.offsetY;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  }

  _onPointerMove(e) {
    if (!this.isDragging) return;
    this.offsetX = e.clientX - this.dragStartX;
    this.offsetY = e.clientY - this.dragStartY;
    this.requestRenderIfGenerationChanged(true);
  }

  _onPointerUp(e) {
    if (this.isDragging) {
      this.isDragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    }
    this.canvas.style.cursor = "default";
  }

  _zoomAt(screenX, screenY, factor) {
    const old = this.scale;
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    const worldX = (screenX - this.offsetX) / old;
    const worldY = (screenY - this.offsetY) / old;
    this.offsetX = screenX - worldX * this.scale;
    this.offsetY = screenY - worldY * this.scale;
    this.requestRenderIfGenerationChanged(true);
  }

  _viewMatrix() {
    return new Float32Array([
      this.scale, 0, 0,
      0, this.scale, 0,
      this.offsetX, this.offsetY, 1,
    ]);
  }

  _initPrograms() {
    const gl = this.gl;
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.baseVao = gl.createVertexArray();
    this.baseVbo = gl.createBuffer();
    gl.bindVertexArray(this.baseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.baseVbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.edgeProgram = createProgram(
      gl,
      `#version 300 es
      precision highp float;
      layout(location=0) in vec2 a_uv;
      layout(location=1) in vec2 a_p0;
      layout(location=2) in vec2 a_p3;
      layout(location=3) in float a_h;
      layout(location=4) in float a_width;
      layout(location=5) in vec4 a_color;
      uniform mat3 u_view;
      uniform vec2 u_viewportPx;
      uniform float u_glowPx;
      uniform float u_aaPx;
      out vec2 v_screenPx;
      out vec2 v_p0; out vec2 v_p1; out vec2 v_p2; out vec2 v_p3;
      out float v_width;
      out vec4 v_color;
      vec2 applyView(vec2 p) { return (u_view * vec3(p, 1.0)).xy; }
      void main() {
        vec2 w0 = a_p0;
        vec2 w3 = a_p3;
        vec2 hdir = normalize(vec2(max(0.0001, abs(w3.x - w0.x)), 0.0));
        float h = a_h;
        vec2 w1 = w0 + hdir * h;
        vec2 w2 = w3 - hdir * h;

        vec2 p0 = applyView(w0);
        vec2 p1 = applyView(w1);
        vec2 p2 = applyView(w2);
        vec2 p3 = applyView(w3);

        vec2 mn = min(min(p0, p1), min(p2, p3));
        vec2 mx = max(max(p0, p1), max(p2, p3));
        float pad = a_width + u_glowPx + u_aaPx;
        mn -= vec2(pad);
        mx += vec2(pad);
        vec2 screenPx = mix(mn, mx, a_uv);
        v_screenPx = screenPx;
        v_p0 = p0; v_p1 = p1; v_p2 = p2; v_p3 = p3;
        v_width = a_width;
        v_color = a_color;
        vec2 ndc = (screenPx / u_viewportPx) * 2.0 - 1.0;
        ndc.y = -ndc.y;
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      in vec2 v_screenPx;
      in vec2 v_p0; in vec2 v_p1; in vec2 v_p2; in vec2 v_p3;
      in float v_width;
      in vec4 v_color;
      uniform float u_glowPx;
      out vec4 outColor;
      vec2 bez(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
        float u = 1.0 - t;
        return (u*u*u)*p0 + (3.0*u*u*t)*p1 + (3.0*u*t*t)*p2 + (t*t*t)*p3;
      }
      float segDist(vec2 p, vec2 a, vec2 b) {
        vec2 ab = b - a;
        float ab2 = dot(ab, ab);
        float t = ab2 > 1e-6 ? clamp(dot(p - a, ab) / ab2, 0.0, 1.0) : 0.0;
        return length(p - (a + t * ab));
      }
      void main() {
        const int N = 24;
        float minD = 1e20;
        vec2 prev = bez(v_p0, v_p1, v_p2, v_p3, 0.0);
        for (int i = 1; i <= N; i++) {
          float t = float(i) / float(N);
          vec2 cur = bez(v_p0, v_p1, v_p2, v_p3, t);
          minD = min(minD, segDist(v_screenPx, prev, cur));
          prev = cur;
        }
        float aa = max(1.0, fwidth(minD));
        float lineA = 1.0 - smoothstep(v_width - aa, v_width + aa, minD);
        float glowA = 0.0;
        if (u_glowPx > 0.0) {
          glowA = 1.0 - smoothstep(v_width + u_glowPx, v_width + u_glowPx + aa, minD);
          glowA *= 0.34;
        }
        float a = lineA + glowA;
        if (a <= 0.001) discard;
        outColor = vec4(v_color.rgb, v_color.a * a);
      }`
    );

    this.nodeProgram = createProgram(
      gl,
      `#version 300 es
      precision highp float;
      layout(location=0) in vec2 a_uv;
      layout(location=1) in vec4 a_rect;
      layout(location=2) in vec4 a_fill;
      layout(location=3) in vec4 a_border;
      uniform mat3 u_view;
      uniform vec2 u_viewportPx;
      out vec2 v_local;
      out vec2 v_size;
      out vec4 v_fill;
      out vec4 v_border;
      void main() {
        vec2 world = a_rect.xy + a_uv * a_rect.zw;
        vec2 screen = (u_view * vec3(world, 1.0)).xy;
        v_local = a_uv * a_rect.zw;
        v_size = a_rect.zw;
        v_fill = a_fill;
        v_border = a_border;
        vec2 ndc = (screen / u_viewportPx) * 2.0 - 1.0;
        ndc.y = -ndc.y;
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      in vec2 v_local;
      in vec2 v_size;
      in vec4 v_fill;
      in vec4 v_border;
      uniform sampler2D u_skin;
      uniform vec2 u_skinSize;
      uniform vec4 u_slice;
      out vec4 outColor;

      float mapAxis(float p, float size, float s0, float s1, float texSize) {
        float inner = max(1.0, size - s0 - s1);
        float texInner = max(1.0, texSize - s0 - s1);
        if (p < s0) {
          return (p / max(1.0, s0)) * (s0 / texSize);
        }
        if (p > size - s1) {
          float d = size - p;
          return 1.0 - ((d / max(1.0, s1)) * (s1 / texSize));
        }
        float t = (p - s0) / inner;
        return (s0 / texSize) + t * (texInner / texSize);
      }

      void main() {
        float u = mapAxis(v_local.x, v_size.x, u_slice.x, u_slice.y, u_skinSize.x);
        float v = mapAxis(v_local.y, v_size.y, u_slice.z, u_slice.w, u_skinSize.y);
        vec4 skin = texture(u_skin, vec2(u, v));
        float borderMask = skin.r;
        float fillMask = skin.g;
        vec4 col = vec4(0.0);
        col += v_fill * fillMask;
        col += v_border * borderMask;
        col.a = max(col.a, max(fillMask * v_fill.a, borderMask * v_border.a));
        if (col.a < 0.001) discard;
        outColor = col;
      }`
    );

    this.textProgram = createProgram(
      gl,
      `#version 300 es
      precision highp float;
      layout(location=0) in vec2 a_uv;
      uniform mat3 u_view;
      uniform vec2 u_viewport;
      uniform vec2 uP;
      uniform vec4 uT;
      uniform vec4 u_uv;
      out vec2 v_uv;
      void main() {
        vec2 aP = a_uv * 2.0 - 1.0;
        vec2 world = aP * mat2(uT) + uP;
        vec2 screen = (u_view * vec3(world, 1.0)).xy;
        vec2 aP01 = aP * 0.5 + 0.5;
        vec2 aFlip = vec2(aP01.x, 1.0 - aP01.y);
        v_uv = u_uv.xy + aFlip * u_uv.zw;
        vec2 ndc = (screen / u_viewport) * 2.0 - 1.0;
        ndc.y = -ndc.y;
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec4 u_color;
      uniform float u_aa;
      uniform float uDistRange;
      uniform int uEffect;
      uniform float uStroke;
      uniform float uGlow;
      uniform vec2 uShadowPx;
      uniform vec2 uAtlasSize;
      out vec4 outColor;
      float median(float r, float g, float b) {
        return max(min(r, g), min(max(r, g), b));
      }
      void main() {
        vec4 tex = texture(u_tex, v_uv);
        float msdf = median(tex.r, tex.g, tex.b) - 0.5;
        float sdf = tex.a - 0.5;
        float fill = clamp(msdf * u_aa + 0.5, 0.0, 1.0);
        float distPx = sdf * uDistRange;

        float outline = 1.0 - smoothstep(max(0.0, uStroke - 1.0), uStroke + 1.0, abs(distPx));
        float outsideDist = max(0.0, -distPx);
        float glow = (1.0 - smoothstep(0.0, max(0.001, uGlow), outsideDist)) * (1.0 - fill);

        vec2 suv = v_uv + (uShadowPx / uAtlasSize);
        float sdist = (texture(u_tex, suv).a - 0.5) * uDistRange;
        float shadowOutside = max(0.0, -sdist);
        float shadow = (1.0 - smoothstep(0.0, max(0.001, uGlow), shadowOutside)) * (1.0 - fill);

        float alpha = fill;
        if (uEffect == 1) {
          alpha = max(outline, fill);
        } else if (uEffect == 2) {
          alpha = max(fill, glow * 0.8);
        } else if (uEffect == 3) {
          alpha = max(fill, shadow * 0.65);
        } else if (uEffect == 4) {
          alpha = max(fill, max(outline * 0.8, glow * 0.55));
        }
        if (alpha < 0.001) discard;
        outColor = vec4(u_color.rgb, u_color.a * alpha);
      }`
    );

    this.edgeBuffer = gl.createBuffer();
    this.nodeBuffer = gl.createBuffer();
    this.textAtlas = null;
    this._buildNineSliceTexture();
  }

  _buildNineSliceTexture() {
    if (!this.gl || !this.assets) return;
    const gl = this.gl;
    const cfg = this.assets.nineSlice;
    const size = cfg.size || 64;
    const borderPx = cfg.borderPx || 2;

    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const cx = c.getContext("2d");
    cx.clearRect(0, 0, size, size);

    const img = cx.createImageData(size, size);
    const data = img.data;
    const r = size * 0.2;
    const innerR = Math.max(1, r - borderPx);
    const cx0 = size * 0.5;
    const cy0 = size * 0.5;
    const half = size * 0.5;

    function sdRoundRect(px, py, hw, hh, rr) {
      const dx = Math.abs(px) - (hw - rr);
      const dy = Math.abs(py) - (hh - rr);
      const qx = Math.max(dx, 0);
      const qy = Math.max(dy, 0);
      return Math.hypot(qx, qy) + Math.min(Math.max(dx, dy), 0) - rr;
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = x + 0.5 - cx0;
        const py = y + 0.5 - cy0;
        const dOuter = sdRoundRect(px, py, half - 1, half - 1, r);
        const dInner = sdRoundRect(px, py, half - 1 - borderPx, half - 1 - borderPx, innerR);
        const outer = dOuter <= 0 ? 1 : 0;
        const inner = dInner <= 0 ? 1 : 0;
        const border = Math.max(0, outer - inner);
        const fill = inner;
        const i = (y * size + x) * 4;
        data[i + 0] = Math.round(border * 255);
        data[i + 1] = Math.round(fill * 255);
        data[i + 2] = 0;
        data[i + 3] = Math.round(Math.max(border, fill) * 255);
      }
    }
    cx.putImageData(img, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    this.skinTexture = { texture: tex, size };
  }

  async _loadTextAtlasFromAssets() {
    const source = this.assets?.text?.source;
    if (!source?.metaUrl || !source?.atlasUrl) {
      throw new Error("missing text.source.metaUrl or text.source.atlasUrl");
    }

    const [metaRes, atlasRes] = await Promise.all([
      fetch(source.metaUrl, { cache: "no-cache" }),
      fetch(source.atlasUrl, { cache: "no-cache" }),
    ]);
    if (!metaRes.ok) throw new Error(`failed to fetch ${source.metaUrl}: ${metaRes.status}`);
    if (!atlasRes.ok) throw new Error(`failed to fetch ${source.atlasUrl}: ${atlasRes.status}`);

    const meta = await metaRes.json();
    const atlasBlob = await atlasRes.blob();
    const atlasImage = await createImageBitmap(atlasBlob);
    const glyphs = buildGlyphMap(meta);

    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasImage);

    this.textAtlas = {
      texture: tex,
      glyphs,
      atlasW: Number(meta.atlas.width),
      atlasH: Number(meta.atlas.height),
      atlasSize: Number(meta.atlas.size),
      distRange: Number(meta.atlas.distanceRange || 8),
      lineHeight: Number(meta.metrics?.lineHeight || 1.2),
    };
  }

  _ensureLayout(nodeId, index) {
    if (this.nodeLayout.has(nodeId)) return this.nodeLayout.get(nodeId);
    const col = index % 4;
    const row = Math.floor(index / 4);
    const pos = { x: 80 + col * 186, y: 58 + row * 112 };
    this.nodeLayout.set(nodeId, pos);
    return pos;
  }

  _readGraph() {
    const ptr = this.api.ng_get_info_ptr();
    const nodes = [];
    const edges = [];
    for (let i = 0; i < NG.MAX_NODES; i++) {
      const base = ptr + INFO.NODES + i * ABI.NODE_SIZE;
      const id = this.dv.getUint32(base + NODE.ID, true);
      if (id === 0) continue;
      const kind = this.dv.getUint32(base + NODE.KIND, true);
      const execState = this.dv.getUint32(base + NODE.EXEC_STATE, true);
      const inputCount = this.dv.getUint32(base + NODE.INPUT_COUNT, true);
      const node = { id, kind, execState, inputCount, inputs: [] };

      for (let j = 0; j < inputCount; j++) {
        const inBase = base + ABI.NODE_HEADER_SIZE + j * ABI.INPUT_PORT_SIZE;
        const inputId = this.dv.getUint32(inBase, true);
        const srcNodeId = this.dv.getUint32(inBase + 4, true);
        const srcOutputId = this.dv.getUint32(inBase + 8, true);
        node.inputs.push({ inputId, srcNodeId, srcOutputId });
        if (srcNodeId) edges.push({ from: srcNodeId, to: id, execState });
      }
      nodes.push(node);
    }
    return { nodes, edges };
  }

  _colorForExec(state, key) {
    const t = this.assets.theme;
    if (state === 1) return t[`${key}Success`] || t[key];
    if (state === 2) return t[`${key}Error`] || t[key];
    if (state === 3) return t[`${key}Stale`] || t[key];
    return t[key];
  }

  _render() {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const graph = this._readGraph();
    const posById = new Map();
    graph.nodes.forEach((node, i) => {
      posById.set(node.id, this._ensureLayout(node.id, i));
    });

    gl.viewport(0, 0, width, height);
    const clear = this.assets.theme.clear;
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const view = this._viewMatrix();
    this._drawEdges(graph.edges, posById, width, height, view);
    this._drawNodes(graph.nodes, posById, width, height, view);
    this._drawLabels(graph.nodes, posById, width, height, view);
  }

  _drawEdges(edges, posById, width, height, view) {
    const gl = this.gl;
    if (!edges.length) return;
    const nodeCfg = this.assets.node;
    const edgeCfg = this.assets.edge;
    const data = new Float32Array(edges.length * 10);
    let o = 0;
    for (const edge of edges) {
      const from = posById.get(edge.from);
      const to = posById.get(edge.to);
      if (!from || !to) continue;
      const p0x = from.x + nodeCfg.width;
      const p0y = from.y + nodeCfg.height * 0.5;
      const p3x = to.x;
      const p3y = to.y + nodeCfg.height * 0.5;
      const h = Math.max(edgeCfg.handleMin, Math.min(edgeCfg.handleMax, Math.abs(p3x - p0x) * 0.5));
      const c = this._colorForExec(edge.execState, "edge");
      data[o++] = p0x;
      data[o++] = p0y;
      data[o++] = p3x;
      data[o++] = p3y;
      data[o++] = h;
      data[o++] = edgeCfg.halfWidthPx;
      data[o++] = c[0];
      data[o++] = c[1];
      data[o++] = c[2];
      data[o++] = c[3];
    }

    gl.useProgram(this.edgeProgram);
    gl.bindVertexArray(this.baseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 10 * 4;

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(5, 1);

    gl.uniformMatrix3fv(gl.getUniformLocation(this.edgeProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.edgeProgram, "u_viewportPx"), width, height);
    gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "u_glowPx"), edgeCfg.glowPx);
    gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "u_aaPx"), edgeCfg.aaPx);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edges.length);
  }

  _drawNodes(nodes, posById, width, height, view) {
    const gl = this.gl;
    if (!nodes.length || !this.skinTexture) return;

    const data = new Float32Array(nodes.length * 12);
    let o = 0;
    for (const node of nodes) {
      const pos = posById.get(node.id);
      const fill = this.assets.theme.nodeFill;
      const border = this._colorForExec(node.execState, "nodeBorder");
      data[o++] = pos.x;
      data[o++] = pos.y;
      data[o++] = this.assets.node.width;
      data[o++] = this.assets.node.height;
      data[o++] = fill[0];
      data[o++] = fill[1];
      data[o++] = fill[2];
      data[o++] = fill[3];
      data[o++] = border[0];
      data[o++] = border[1];
      data[o++] = border[2];
      data[o++] = border[3];
    }

    gl.useProgram(this.nodeProgram);
    gl.bindVertexArray(this.baseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 12 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.skinTexture.texture);
    gl.uniform1i(gl.getUniformLocation(this.nodeProgram, "u_skin"), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.nodeProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.nodeProgram, "u_viewportPx"), width, height);
    gl.uniform2f(gl.getUniformLocation(this.nodeProgram, "u_skinSize"), this.skinTexture.size, this.skinTexture.size);
    gl.uniform4f(
      gl.getUniformLocation(this.nodeProgram, "u_slice"),
      this.assets.nineSlice.left,
      this.assets.nineSlice.right,
      this.assets.nineSlice.top,
      this.assets.nineSlice.bottom
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodes.length);
  }

  _drawLabels(nodes, posById, width, height, view) {
    const gl = this.gl;
    if (!this.textAtlas) return;
    const glyphs = this.textAtlas.glyphs;
    const c = this.assets.theme.text;

    gl.useProgram(this.textProgram);
    gl.bindVertexArray(this.baseVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textAtlas.texture);
    gl.uniform1i(gl.getUniformLocation(this.textProgram, "u_tex"), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.textProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.textProgram, "u_viewport"), width, height);
    gl.uniform4f(gl.getUniformLocation(this.textProgram, "u_color"), c[0], c[1], c[2], c[3]);
    const aaBase = Number(this.assets.text.aa || 8);
    const aa = Math.min(32.0, Math.max(6.0, aaBase * this.scale));
    gl.uniform1f(gl.getUniformLocation(this.textProgram, "u_aa"), aa);
    gl.uniform1f(gl.getUniformLocation(this.textProgram, "uDistRange"), this.textAtlas.distRange);
    const effectNames = { fill: 0, outline: 1, glow: 2, shadow: 3, combo: 4 };
    const rawEffect = String(this.assets.text.effect || "fill").toLowerCase();
    const effect = Number.isFinite(Number(rawEffect)) ? Number(rawEffect) : (effectNames[rawEffect] ?? 0);
    gl.uniform1i(gl.getUniformLocation(this.textProgram, "uEffect"), effect);
    gl.uniform1f(gl.getUniformLocation(this.textProgram, "uStroke"), Number(this.assets.text.stroke || 2.5));
    gl.uniform1f(gl.getUniformLocation(this.textProgram, "uGlow"), Number(this.assets.text.glow || 2));
    gl.uniform2f(
      gl.getUniformLocation(this.textProgram, "uShadowPx"),
      Number(this.assets.text.shadowX || 4),
      Number(this.assets.text.shadowY || -4)
    );
    gl.uniform2f(gl.getUniformLocation(this.textProgram, "uAtlasSize"), this.textAtlas.atlasW, this.textAtlas.atlasH);

    const fontScale = this.assets.text.fontPx / Math.max(1, this.textAtlas.atlasSize || 48);

    const drawText = (text, startX, baselineY) => {
      let x = startX;
      for (const ch of text) {
        const g = glyphs.get(ch.codePointAt(0));
        if (!g) {
          x += (this.textAtlas.atlasSize || 48) * 0.3 * fontScale;
          continue;
        }
        if (g.empty) {
          x += g.advancePx * fontScale;
          continue;
        }
        const gw = g.widthPx * fontScale;
        const gh = g.heightPx * fontScale;
        const px = x + g.offsetXPx * fontScale;
        const py = baselineY + g.baselineOffsetYPx * fontScale;
        gl.uniform2f(gl.getUniformLocation(this.textProgram, "uP"), px, py);
        gl.uniform4f(gl.getUniformLocation(this.textProgram, "uT"), gw * 0.5, 0, 0, gh * 0.5);
        gl.uniform4f(gl.getUniformLocation(this.textProgram, "u_uv"), g.uv[0], g.uv[1], g.uv[2], g.uv[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        x += g.advancePx * fontScale;
      }
    };

    for (const node of nodes) {
      const pos = posById.get(node.id);
      const labelA = `${node.kind === NG.NODE_CODE ? "code" : node.kind === NG.NODE_GOAL ? "goal" : "node"} #${node.id}`;
      const labelB = `state ${node.execState}  agjpqy 0123`;
      const x = pos.x + 10;
      const yA = pos.y + this.assets.text.fontPx + 2;
      const yB = yA + this.assets.text.fontPx * 0.92;
      drawText(labelA, x, yA);
      drawText(labelB, x, yB);
    }
  }
}

if (!customElements.get("node-graph-canvas")) {
  customElements.define("node-graph-canvas", NodeGraphCanvasElement);
}

export { NodeGraphCanvasElement };
