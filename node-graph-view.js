const NG = {
  MAX_NODES: 1024,
  MAX_INPUTS: 32,
  MAX_OUTPUTS: 32,
  MAX_ARGS: 32,
  NODE_GOAL: 1,
  NODE_CODE: 2,
  NODE_VALUE: 4,
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
  NODES: 24 + ABI.I32,
};

const NODE = {
  ID: 0,
  KIND: 4,
  EXEC_STATE: 8,
  INPUT_COUNT: 20,
  OUTPUT_COUNT: 24,
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
    this.isPanning = false;
    this.isNodeDragging = false;
    this.nodeDragStartWorld = { x: 0, y: 0 };
    this.nodeDragItems = [];

    this.textAtlas = null;
    this.skinTexture = null;
    this.portTextures = null;
    this.portLabels = new Map();
    this.lastGraph = null;
    this.lastPosById = new Map();
    this.hoverPick = null;
    this.selectedNodeIds = new Set();
    this.connectionDrag = null;

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
      Promise.all([
        this._loadNineSliceTextureFromAssets(),
        this._loadTextAtlasFromAssets(),
        this._loadPortTexturesFromAssets(),
      ])
        .then(() => this.requestRenderIfGenerationChanged(true))
        .catch((err) => {
          console.error("graph asset load failed", err);
        });
    }
  }

  setNodeLayoutMap(map) {
    this.nodeLayout = map;
    this.requestRenderIfGenerationChanged(true);
  }

  setPortLabelMap(map) {
    this.portLabels = map || new Map();
    this.requestRenderIfGenerationChanged(true);
  }

  getGraphSnapshot() {
    if (!this.api || !this.memory) return { nodes: [], edges: [] };
    if (!this._ensureDataView()) return { nodes: [], edges: [] };
    return this._readGraph();
  }

  getSelectedNodeIds() {
    return Array.from(this.selectedNodeIds || []);
  }

  attachRuntime({ api, memory }) {
    this.api = api;
    this.memory = memory;
    this.dv = new DataView(memory.buffer);
    this.requestRenderIfGenerationChanged(true);
  }

  _ensureDataView() {
    if (!this.memory) return false;
    if (!this.dv || this.dv.buffer !== this.memory.buffer) {
      this.dv = new DataView(this.memory.buffer);
    }
    return true;
  }

  requestRenderIfGenerationChanged(force = false) {
    if (!this.gl || !this.api || !this.memory || !this.assets) return;
    if (!this._ensureDataView()) return;
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
    if (!this.gl) return;

    const world = this._worldFromClientPoint(e.clientX, e.clientY);
    const pick = this._pickFromClientPoint(e.clientX, e.clientY);
    this.hoverPick = pick;
    const multi = e.ctrlKey || e.metaKey;

    if (pick?.kind === "port") {
      this._beginConnectionFromPort(pick);
      if (!this.connectionDrag) return;
      this.connectionDrag.moving = world;
      this._updateConnectionHoverTarget(world.x, world.y);
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "crosshair";
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    if (pick?.kind === "edge") {
      this._beginReconnectFromEdge(pick);
      if (!this.connectionDrag) return;
      this.connectionDrag.moving = world;
      this._updateConnectionHoverTarget(world.x, world.y);
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "crosshair";
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    if (!pick) {
      const hadSelection = this.selectedNodeIds.size > 0;
      if (!multi) this.selectedNodeIds.clear();
      if (hadSelection && !this.selectedNodeIds.size) this._emitSelectionChanged();
      this.isDragging = true;
      this.isPanning = true;
      this.isNodeDragging = false;
      this.dragStartX = e.clientX - this.offsetX;
      this.dragStartY = e.clientY - this.offsetY;
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    if (pick.kind === "node") {
      const id = pick.nodeId;
      const before = this.getSelectedNodeIds().join(",");
      if (multi) {
        if (this.selectedNodeIds.has(id)) this.selectedNodeIds.delete(id);
        else this.selectedNodeIds.add(id);
      } else {
        const keepGroupSelection = this.selectedNodeIds.size > 1 && this.selectedNodeIds.has(id);
        if (!keepGroupSelection) {
          this.selectedNodeIds.clear();
          this.selectedNodeIds.add(id);
        }
      }
      const after = this.getSelectedNodeIds().join(",");
      if (before !== after) this._emitSelectionChanged();

      const dragTargets = this.selectedNodeIds.has(id) ? Array.from(this.selectedNodeIds) : [id];
      this.isDragging = true;
      this.isPanning = false;
      this.isNodeDragging = true;
      this.nodeDragStartWorld = world;
      this.nodeDragItems = dragTargets
        .map((nodeId) => {
          const pos = this.nodeLayout.get(nodeId);
          if (!pos) return null;
          return { nodeId, startX: pos.x, startY: pos.y };
        })
        .filter(Boolean);
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    this.isDragging = false;
    this.isPanning = false;
    this.isNodeDragging = false;
    this.canvas.style.cursor = "crosshair";

    this.requestRenderIfGenerationChanged(true);
  }

  _onPointerMove(e) {
    if (this.connectionDrag) {
      const world = this._worldFromClientPoint(e.clientX, e.clientY);
      this.connectionDrag.moving = world;
      this._updateConnectionHoverTarget(world.x, world.y);
      this.canvas.style.cursor = "crosshair";
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    if (this.isDragging && this.isNodeDragging) {
      const world = this._worldFromClientPoint(e.clientX, e.clientY);
      const dx = world.x - this.nodeDragStartWorld.x;
      const dy = world.y - this.nodeDragStartWorld.y;
      for (const item of this.nodeDragItems) {
        const pos = this.nodeLayout.get(item.nodeId);
        if (!pos) continue;
        pos.x = Math.round(item.startX + dx);
        pos.y = Math.round(item.startY + dy);
      }
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    if (this.isDragging && this.isPanning) {
      this.offsetX = e.clientX - this.dragStartX;
      this.offsetY = e.clientY - this.dragStartY;
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    const pick = this._pickFromClientPoint(e.clientX, e.clientY);
    this.hoverPick = pick;
    this.canvas.style.cursor = pick ? "crosshair" : "default";
    this.requestRenderIfGenerationChanged(true);
  }

  _onPointerUp(e) {
    if (this.connectionDrag) {
      this._finishConnectionDrag();
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this.canvas.style.cursor = "default";
      this.requestRenderIfGenerationChanged(true);
      return;
    }

    if (this.isDragging) {
      this.isDragging = false;
      this.isPanning = false;
      this.isNodeDragging = false;
      this.nodeDragItems = [];
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    }
    if (!this.isDragging) {
      const pick = this._pickFromClientPoint(e.clientX, e.clientY);
      this.hoverPick = pick;
      this.canvas.style.cursor = pick ? "crosshair" : "default";
      this.requestRenderIfGenerationChanged(true);
    }
  }

  _beginConnectionFromPort(portPick) {
    const nodesById = new Map((this.lastGraph?.nodes || []).map((node) => [node.id, node]));
    const node = nodesById.get(portPick.nodeId);
    const pos = this.lastPosById.get(portPick.nodeId);
    if (!node || !pos) return;

    const p = this._getPortCenter(node, pos, portPick.direction === "input", portPick.index);
    this.connectionDrag = {
      mode: portPick.direction === "output" ? "from-output" : "from-input",
      fixed: {
        nodeId: portPick.nodeId,
        direction: portPick.direction,
        index: portPick.index,
        portId: portPick.portId,
        x: p.x,
        y: p.y,
      },
      moving: { x: p.x, y: p.y },
      hoverTarget: null,
      validTarget: null,
      originalEdge: null,
    };

    if (portPick.direction === "input" && portPick.connected) {
      const existingEdge = (this.lastGraph?.edges || []).find(
        (edge) => edge.to === portPick.nodeId && edge.toInputId === portPick.portId
      );
      if (existingEdge) {
        this.connectionDrag.mode = "reconnect-input";
        this.connectionDrag.originalEdge = existingEdge;
        this.connectionDrag.fixed = {
          nodeId: existingEdge.from,
          direction: "output",
          index: this._getOutputIndex(nodesById.get(existingEdge.from), existingEdge.fromOutputId),
          portId: existingEdge.fromOutputId,
          x: this._getPortCenter(
            nodesById.get(existingEdge.from),
            this.lastPosById.get(existingEdge.from),
            false,
            this._getOutputIndex(nodesById.get(existingEdge.from), existingEdge.fromOutputId)
          ).x,
          y: this._getPortCenter(
            nodesById.get(existingEdge.from),
            this.lastPosById.get(existingEdge.from),
            false,
            this._getOutputIndex(nodesById.get(existingEdge.from), existingEdge.fromOutputId)
          ).y,
        };
      }
    }
  }

  _beginReconnectFromEdge(edgePick) {
    const edge = edgePick.edge;
    if (!edge) return;
    const nodesById = new Map((this.lastGraph?.nodes || []).map((node) => [node.id, node]));
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    const fromPos = this.lastPosById.get(edge.from);
    const toPos = this.lastPosById.get(edge.to);
    if (!fromNode || !toNode || !fromPos || !toPos) return;

    const fromIndex = this._getOutputIndex(fromNode, edge.fromOutputId);
    const toIndex = this._getInputIndex(toNode, edge.toInputId);
    const fromPort = this._getPortCenter(fromNode, fromPos, false, fromIndex);
    const toPort = this._getPortCenter(toNode, toPos, true, toIndex);

    if (edgePick.side === "output") {
      this.connectionDrag = {
        mode: "reconnect-output",
        fixed: {
          nodeId: edge.to,
          direction: "input",
          index: toIndex,
          portId: edge.toInputId,
          x: toPort.x,
          y: toPort.y,
        },
        moving: { x: fromPort.x, y: fromPort.y },
        hoverTarget: null,
        validTarget: null,
        originalEdge: edge,
      };
      return;
    }

    this.connectionDrag = {
      mode: "reconnect-input",
      fixed: {
        nodeId: edge.from,
        direction: "output",
        index: fromIndex,
        portId: edge.fromOutputId,
        x: fromPort.x,
        y: fromPort.y,
      },
      moving: { x: toPort.x, y: toPort.y },
      hoverTarget: null,
      validTarget: null,
      originalEdge: edge,
    };
  }

  _updateConnectionHoverTarget(worldX, worldY) {
    if (!this.connectionDrag || !this.lastGraph) return;
    const hit = this._hitTestPort(worldX, worldY, this.lastGraph.nodes, this.lastPosById);
    if (!hit) {
      this.connectionDrag.hoverTarget = null;
      this.connectionDrag.validTarget = null;
      this.hoverPick = null;
      return;
    }
    this.connectionDrag.hoverTarget = hit;
    this.connectionDrag.validTarget = this._validateConnectionTarget(this.connectionDrag, hit) ? hit : null;
    this.hoverPick = { kind: "port", ...hit };
  }

  _validateConnectionTarget(drag, target) {
    if (!drag || !target) return false;
    if (target.direction === drag.fixed.direction) return false;
    if (target.nodeId === drag.fixed.nodeId) return false;
    return true;
  }

  _applyInputDisconnect(nodeId, inputId) {
    if (!this.api?.ng_input_disconnect) return;
    const err = this.api.ng_input_disconnect(nodeId, inputId);
    if (err !== 0) {
      console.warn(`ng_input_disconnect failed node=${nodeId} input=${inputId} err=${err}`);
    }
  }

  _applyInputConnect(toNodeId, toInputId, fromNodeId, fromOutputId) {
    if (!this.api?.ng_input_connect) return;
    const err = this.api.ng_input_connect(toNodeId, toInputId, fromNodeId, fromOutputId);
    if (err !== 0) {
      console.warn(
        `ng_input_connect failed to=${toNodeId}.${toInputId} from=${fromNodeId}.${fromOutputId} err=${err}`
      );
    }
  }

  _finishConnectionDrag() {
    const drag = this.connectionDrag;
    if (!drag) return;
    const target = drag.validTarget;
    const orig = drag.originalEdge;
    const isReconnect = drag.mode === "reconnect-input" || drag.mode === "reconnect-output";

    if (target) {
      const from = drag.fixed.direction === "output"
        ? drag.fixed
        : {
          nodeId: target.nodeId,
          portId: target.portId,
          direction: target.direction,
        };
      const to = drag.fixed.direction === "input"
        ? drag.fixed
        : {
          nodeId: target.nodeId,
          portId: target.portId,
          direction: target.direction,
        };

      const sameAsOriginal = Boolean(
        orig &&
        from.nodeId === orig.from &&
        from.portId === orig.fromOutputId &&
        to.nodeId === orig.to &&
        to.portId === orig.toInputId
      );

      if (isReconnect && orig && !sameAsOriginal) {
        this._applyInputDisconnect(orig.to, orig.toInputId);
      }

      if (!sameAsOriginal) {
        this._applyInputConnect(to.nodeId, to.portId, from.nodeId, from.portId);
      }
    } else if (isReconnect && orig) {
      this._applyInputDisconnect(orig.to, orig.toInputId);
    }

    this.connectionDrag = null;
  }

  _canvasPxFromClientPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (this.canvas.width / Math.max(1, rect.width)),
      y: (clientY - rect.top) * (this.canvas.height / Math.max(1, rect.height)),
    };
  }

  _worldFromClientPoint(clientX, clientY) {
    const px = this._canvasPxFromClientPoint(clientX, clientY);
    return this._screenToWorld(px.x, px.y);
  }

  _screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.offsetX) / this.scale,
      y: (screenY - this.offsetY) / this.scale,
    };
  }

  _pickFromClientPoint(clientX, clientY) {
    if (!this.lastGraph || !this.lastPosById?.size) return null;
    const px = this._canvasPxFromClientPoint(clientX, clientY);
    const x = px.x;
    const y = px.y;
    const world = this._screenToWorld(x, y);

    const portHit = this._hitTestPort(world.x, world.y, this.lastGraph.nodes, this.lastPosById);
    if (portHit) return { kind: "port", ...portHit };

    const nodeHit = this._hitTestNode(world.x, world.y, this.lastGraph.nodes, this.lastPosById);
    if (nodeHit) return { kind: "node", ...nodeHit };

    const edgeHit = this._hitTestEdge(world.x, world.y, this.lastGraph.nodes, this.lastGraph.edges, this.lastPosById);
    if (edgeHit) return { kind: "edge", ...edgeHit };

    return null;
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
      uniform mat3 u_view;
      uniform vec2 u_viewportPx;
      out vec2 v_local;
      out vec2 v_size;
      void main() {
        vec2 world = a_rect.xy + a_uv * a_rect.zw;
        vec2 screen = (u_view * vec3(world, 1.0)).xy;
        v_local = a_uv * a_rect.zw;
        v_size = a_rect.zw;
        vec2 ndc = (screen / u_viewportPx) * 2.0 - 1.0;
        ndc.y = -ndc.y;
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      in vec2 v_local;
      in vec2 v_size;
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
        if (skin.a < 0.001) discard;
        outColor = skin;
      }`
    );

    this.spriteProgram = createProgram(
      gl,
      `#version 300 es
      precision highp float;
      layout(location=0) in vec2 a_uv;
      layout(location=1) in vec4 a_rect;
      layout(location=2) in vec4 a_uvRect;
      uniform mat3 u_view;
      uniform vec2 u_viewportPx;
      out vec2 v_uv;
      void main() {
        vec2 world = a_rect.xy + a_uv * a_rect.zw;
        vec2 screen = (u_view * vec3(world, 1.0)).xy;
        v_uv = a_uvRect.xy + a_uv * a_uvRect.zw;
        vec2 ndc = (screen / u_viewportPx) * 2.0 - 1.0;
        ndc.y = -ndc.y;
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`,
      `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_tex;
      out vec4 outColor;
      void main() {
        vec4 tex = texture(u_tex, v_uv);
        if (tex.a < 0.001) discard;
        outColor = tex;
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
    this.spriteBuffer = gl.createBuffer();
    this.textAtlas = null;
  }

  async _loadTextureFromUrl(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`failed to fetch ${url}: ${res.status}`);
    }
    const blob = await res.blob();
    const image = await createImageBitmap(blob);

    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return { texture: tex, width: image.width, height: image.height };
  }

  async _loadNineSliceTextureFromAssets() {
    if (!this.gl || !this.assets) return;
    const cfg = this.assets.nineSlice;
    const textureUrl = cfg?.textureUrl;
    if (!textureUrl) {
      throw new Error("missing nineSlice.textureUrl");
    }

    const gl = this.gl;
    const texInfo = await this._loadTextureFromUrl(textureUrl);
    if (this.skinTexture?.texture) {
      gl.deleteTexture(this.skinTexture.texture);
    }
    this.skinTexture = texInfo;
  }

  async _loadPortTexturesFromAssets() {
    if (!this.gl || !this.assets?.ports) return;
    const gl = this.gl;
    const cfg = this.assets.ports;
    if (!cfg.emptyIconUrl || !cfg.fullIconUrl) {
      throw new Error("missing ports.emptyIconUrl or ports.fullIconUrl");
    }

    const [empty, full] = await Promise.all([
      this._loadTextureFromUrl(cfg.emptyIconUrl),
      this._loadTextureFromUrl(cfg.fullIconUrl),
    ]);

    if (this.portTextures?.empty?.texture) gl.deleteTexture(this.portTextures.empty.texture);
    if (this.portTextures?.full?.texture) gl.deleteTexture(this.portTextures.full.texture);
    this.portTextures = { empty, full };
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
    const layout = this.assets.layout;
    const col = index % layout.gridColumns;
    const row = Math.floor(index / layout.gridColumns);
    const pos = {
      x: layout.gridOriginX + col * layout.gridStepX,
      y: layout.gridOriginY + row * layout.gridStepY,
    };
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
      const outputCount = this.dv.getUint32(base + NODE.OUTPUT_COUNT, true);
      const node = { id, kind, execState, inputCount, outputCount, inputs: [], outputs: [] };

      for (let j = 0; j < inputCount; j++) {
        const inBase = base + ABI.NODE_HEADER_SIZE + j * ABI.INPUT_PORT_SIZE;
        const inputId = this.dv.getUint32(inBase, true);
        const srcNodeId = this.dv.getUint32(inBase + 4, true);
        const srcOutputId = this.dv.getUint32(inBase + 8, true);
        node.inputs.push({ inputId, srcNodeId, srcOutputId });
        if (srcNodeId) {
          edges.push({
            from: srcNodeId,
            fromOutputId: srcOutputId,
            to: id,
            toInputId: inputId,
            execState,
          });
        }
      }

      const outputsBase = base + ABI.NODE_HEADER_SIZE + NG.MAX_INPUTS * ABI.INPUT_PORT_SIZE;
      for (let j = 0; j < outputCount; j++) {
        const outputId = this.dv.getUint32(outputsBase + j * ABI.OUTPUT_PORT_SIZE, true);
        node.outputs.push({ outputId });
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
    this.lastGraph = graph;
    this.lastPosById = posById;

    gl.viewport(0, 0, width, height);
    const clear = this.assets.theme.clear;
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const view = this._viewMatrix();
    this._drawEdges(graph.nodes, graph.edges, posById, width, height, view);
    this._drawActiveConnection(width, height, view);
    this._drawNodes(graph.nodes, posById, width, height, view);
    this._drawSelectionOverlay(graph.nodes, posById, width, height, view);
    this._drawPorts(graph.nodes, graph.edges, posById, width, height, view);
    this._drawLabels(graph.nodes, posById, width, height, view);
    this._drawPickOverlay(this.hoverPick, graph.nodes, graph.edges, posById, width, height, view);
  }

  _drawActiveConnection(width, height, view) {
    if (!this.connectionDrag) return;
    const drag = this.connectionDrag;
    const edgeCfg = this.assets.edge;
    const active = this.assets.theme.edgeActive || [133 / 255, 192 / 255, 255 / 255, 1];

    let p0;
    let p3;
    if (drag.fixed.direction === "output") {
      p0 = { x: drag.fixed.x, y: drag.fixed.y };
      p3 = drag.moving;
    } else {
      p0 = drag.moving;
      p3 = { x: drag.fixed.x, y: drag.fixed.y };
    }

    const h = Math.max(edgeCfg.handleMin, Math.min(edgeCfg.handleMax, Math.abs(p3.x - p0.x) * 0.5));
    const data = new Float32Array([
      p0.x, p0.y,
      p3.x, p3.y,
      h,
      Math.max(edgeCfg.halfWidthPx * 1.35, edgeCfg.halfWidthPx + 0.5),
      active[0], active[1], active[2], active[3],
    ]);

    const gl = this.gl;
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
    gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "u_glowPx"), Math.max(edgeCfg.glowPx, 4));
    gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "u_aaPx"), edgeCfg.aaPx);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  }

  _worldDistanceToBezier(x, y, p0, p1, p2, p3) {
    let minDist = Infinity;
    let prev = p0;
    const samples = 24;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const u = 1 - t;
      const pt = {
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      };
      const abx = pt.x - prev.x;
      const aby = pt.y - prev.y;
      const apx = x - prev.x;
      const apy = y - prev.y;
      const ab2 = abx * abx + aby * aby;
      const h = ab2 > 1e-6 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2)) : 0;
      const qx = prev.x + abx * h;
      const qy = prev.y + aby * h;
      const dx = x - qx;
      const dy = y - qy;
      const d = Math.hypot(dx, dy);
      if (d < minDist) minDist = d;
      prev = pt;
    }
    return minDist;
  }

  _hitTestNode(worldX, worldY, nodes, posById) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const pos = posById.get(node.id);
      if (!pos) continue;
      const size = this._getNodeSize(node);
      if (
        worldX >= pos.x && worldX <= pos.x + size.width &&
        worldY >= pos.y && worldY <= pos.y + size.height
      ) {
        return { nodeId: node.id };
      }
    }
    return null;
  }

  _hitTestPort(worldX, worldY, nodes, posById) {
    const hitRadiusPx = Number(this.assets.ports.hitRadiusPx || 16);
    const hitRadiusWorld = hitRadiusPx / Math.max(0.0001, this.scale);
    const outputUsage = new Set();
    for (const edge of this.lastGraph?.edges || []) {
      outputUsage.add(`${edge.from}:${edge.fromOutputId}`);
    }

    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const pos = posById.get(node.id);
      if (!pos) continue;

      for (let idx = 0; idx < node.inputCount; idx++) {
        const input = node.inputs[idx];
        const p = this._getPortCenter(node, pos, true, idx);
        if (Math.hypot(worldX - p.x, worldY - p.y) <= hitRadiusWorld) {
          return {
            nodeId: node.id,
            direction: "input",
            index: idx,
            portId: input?.inputId ?? idx + 1,
            connected: Boolean(input?.srcNodeId),
          };
        }
      }

      for (let idx = 0; idx < node.outputCount; idx++) {
        const output = node.outputs[idx];
        const p = this._getPortCenter(node, pos, false, idx);
        if (Math.hypot(worldX - p.x, worldY - p.y) <= hitRadiusWorld) {
          const portId = output?.outputId ?? idx + 1;
          return {
            nodeId: node.id,
            direction: "output",
            index: idx,
            portId,
            connected: outputUsage.has(`${node.id}:${portId}`),
          };
        }
      }
    }
    return null;
  }

  _hitTestEdge(worldX, worldY, nodes, edges, posById) {
    const edgeCfg = this.assets.edge;
    const hitRadiusPx = Number(edgeCfg.hitRadiusPx || 10);
    const hitRadiusWorld = hitRadiusPx / Math.max(0.0001, this.scale);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));

    let best = null;
    for (const edge of edges) {
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      const fromPos = posById.get(edge.from);
      const toPos = posById.get(edge.to);
      if (!fromNode || !toNode || !fromPos || !toPos) continue;

      const fromPortIndex = this._getOutputIndex(fromNode, edge.fromOutputId);
      const toPortIndex = this._getInputIndex(toNode, edge.toInputId);
      const p0 = this._getPortCenter(fromNode, fromPos, false, fromPortIndex);
      const p3 = this._getPortCenter(toNode, toPos, true, toPortIndex);
      const dx = Math.abs(p3.x - p0.x);
      const h = Math.max(edgeCfg.handleMin, Math.min(edgeCfg.handleMax, dx * 0.5));
      const p1 = { x: p0.x + h, y: p0.y };
      const p2 = { x: p3.x - h, y: p3.y };
      const dist = this._worldDistanceToBezier(worldX, worldY, p0, p1, p2, p3);
      if (dist <= hitRadiusWorld && (!best || dist < best.distance)) {
        const dStart = Math.hypot(worldX - p0.x, worldY - p0.y);
        const dEnd = Math.hypot(worldX - p3.x, worldY - p3.y);
        best = {
          edge,
          distance: dist,
          side: dStart <= dEnd ? "output" : "input",
        };
      }
    }

    return best;
  }

  _getInputIndex(node, inputId) {
    if (!node?.inputs?.length) return 0;
    const idx = node.inputs.findIndex((port) => port.inputId === inputId);
    return idx >= 0 ? idx : 0;
  }

  _getOutputIndex(node, outputId) {
    if (!node?.outputs?.length) return 0;
    const idx = node.outputs.findIndex((port) => port.outputId === outputId);
    return idx >= 0 ? idx : 0;
  }

  _getNodeSize(node) {
    const nodeCfg = this.assets.node;
    const layout = this.assets.layout || {};
    const ports = this.assets.ports;
    const width = Number(nodeCfg.width || 146);
    const minHeight = Number(nodeCfg.minHeight || nodeCfg.height || 62);
    const rowCount = Math.max(node.inputCount || 0, node.outputCount || 0);
    if (rowCount <= 0) return { width, height: minHeight };

    const rowStartY = Number(ports.rowStartY || ((layout.nodeHeaderHeight || 28) + 2));
    const spacingY = Number(ports.spacingY || 18);
    const iconSizePx = Number(ports.iconSizePx || 12);
    const nodePaddingY = Number(layout.nodePaddingY || 8);
    const lastPortCenterY = rowStartY + (rowCount - 1) * spacingY;
    const requiredHeight = lastPortCenterY + iconSizePx * 0.5 + nodePaddingY;
    return { width, height: Math.max(minHeight, Math.ceil(requiredHeight)) };
  }

  _getPortCenter(node, pos, isInput, portIndex) {
    const cfg = this.assets.ports;
    const nodeSize = this._getNodeSize(node);
    const x = isInput ? pos.x + cfg.inputInsetX : pos.x + nodeSize.width - cfg.outputInsetX;
    const y = pos.y + cfg.rowStartY + portIndex * cfg.spacingY;
    return { x, y };
  }

  _getNodePortLabels(nodeId) {
    if (!this.portLabels) return null;
    if (this.portLabels instanceof Map) {
      return this.portLabels.get(nodeId) || this.portLabels.get(String(nodeId)) || null;
    }
    return this.portLabels[nodeId] || this.portLabels[String(nodeId)] || null;
  }

  _getPortLabel(nodeId, direction, portId, index) {
    const labels = this._getNodePortLabels(nodeId);
    const dict = labels ? labels[direction === "input" ? "inputs" : "outputs"] : null;
    const key = String(portId);
    if (dict instanceof Map) {
      if (dict.has(portId)) return String(dict.get(portId));
      if (dict.has(key)) return String(dict.get(key));
    } else if (dict && typeof dict === "object") {
      if (dict[portId] !== undefined) return String(dict[portId]);
      if (dict[key] !== undefined) return String(dict[key]);
    }
    return `${direction === "input" ? "in" : "out"} ${portId || index + 1}`;
  }

  _drawEdges(nodes, edges, posById, width, height, view) {
    const gl = this.gl;
    if (!edges.length) return;
    const edgeCfg = this.assets.edge;
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const data = new Float32Array(edges.length * 10);
    let o = 0;
    for (const edge of edges) {
      if (this.connectionDrag?.originalEdge) {
        const orig = this.connectionDrag.originalEdge;
        if (
          edge.from === orig.from &&
          edge.fromOutputId === orig.fromOutputId &&
          edge.to === orig.to &&
          edge.toInputId === orig.toInputId
        ) {
          continue;
        }
      }

      const from = posById.get(edge.from);
      const to = posById.get(edge.to);
      if (!from || !to) continue;
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      const fromPortIndex = this._getOutputIndex(fromNode, edge.fromOutputId);
      const toPortIndex = this._getInputIndex(toNode, edge.toInputId);
      const p0 = this._getPortCenter(fromNode, from, false, fromPortIndex);
      const p3 = this._getPortCenter(toNode, to, true, toPortIndex);
      const p0x = p0.x;
      const p0y = p0.y;
      const p3x = p3.x;
      const p3y = p3.y;
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
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.floor(o / 10));
  }

  _drawPickOverlay(pick, nodes, edges, posById, width, height, view) {
    if (!pick) return;
    if (pick.kind === "port") {
      const node = nodes.find((n) => n.id === pick.nodeId);
      const pos = node ? posById.get(node.id) : null;
      if (!node || !pos || !this.portTextures?.full) return;
      const p = this._getPortCenter(node, pos, pick.direction === "input", pick.index);
      const iconSize = Number(this.assets.ports.iconSizePx || 12) + 4;
      const half = iconSize * 0.5;
      const data = new Float32Array([
        p.x - half, p.y - half, iconSize, iconSize,
        0, 0, 1, 1,
      ]);
      this._drawPortBatch(this.portTextures.full, data, width, height, view);
      return;
    }

    if (pick.kind === "edge" && pick.edge) {
      const edgeCfg = this.assets.edge;
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const fromNode = nodesById.get(pick.edge.from);
      const toNode = nodesById.get(pick.edge.to);
      const fromPos = posById.get(pick.edge.from);
      const toPos = posById.get(pick.edge.to);
      if (!fromNode || !toNode || !fromPos || !toPos) return;

      const fromPortIndex = this._getOutputIndex(fromNode, pick.edge.fromOutputId);
      const toPortIndex = this._getInputIndex(toNode, pick.edge.toInputId);
      const p0 = this._getPortCenter(fromNode, fromPos, false, fromPortIndex);
      const p3 = this._getPortCenter(toNode, toPos, true, toPortIndex);
      const h = Math.max(edgeCfg.handleMin, Math.min(edgeCfg.handleMax, Math.abs(p3.x - p0.x) * 0.5));
      const active = this.assets.theme.edgeActive || [133 / 255, 192 / 255, 255 / 255, 1];
      const data = new Float32Array([
        p0.x, p0.y,
        p3.x, p3.y,
        h,
        Math.max(edgeCfg.halfWidthPx * 1.8, edgeCfg.halfWidthPx + 0.8),
        active[0], active[1], active[2], active[3],
      ]);

      const gl = this.gl;
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
      gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "u_glowPx"), Math.max(edgeCfg.glowPx, 4));
      gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "u_aaPx"), edgeCfg.aaPx);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
      return;
    }

    if (pick.kind === "node") {
      const node = nodes.find((n) => n.id === pick.nodeId);
      const pos = node ? posById.get(node.id) : null;
      if (!node || !pos) return;
      const size = this._getNodeSize(node);
      const active = this.assets.theme.edgeActive || [133 / 255, 192 / 255, 255 / 255, 1];
      this._drawRectOutline([
        {
          x: pos.x - 2,
          y: pos.y - 2,
          width: size.width + 4,
          height: size.height + 4,
          color: [active[0], active[1], active[2], 0.85],
          strokePx: 2,
        },
      ], width, height, view);
    }
  }

  _drawSelectionOverlay(nodes, posById, width, height, view) {
    if (!this.selectedNodeIds?.size) return;
    const selection = this.assets.theme.selection || [74 / 255, 199 / 255, 255 / 255, 1];
    const rects = [];
    for (const node of nodes) {
      if (!this.selectedNodeIds.has(node.id)) continue;
      const pos = posById.get(node.id);
      if (!pos) continue;
      const size = this._getNodeSize(node);
      rects.push({
        x: pos.x - 3,
        y: pos.y - 3,
        width: size.width + 6,
        height: size.height + 6,
        color: [selection[0], selection[1], selection[2], 0.95],
        strokePx: 2,
      });
    }
    this._drawRectOutline(rects, width, height, view);
  }

  _drawRectOutline(rects, width, height, view) {
    if (!rects.length) return;
    const gl = this.gl;
    if (!this.rectProgram) {
      this.rectProgram = createProgram(
        gl,
        `#version 300 es
        precision highp float;
        layout(location=0) in vec2 a_uv;
        layout(location=1) in vec4 a_rect;
        layout(location=2) in vec4 a_color;
        layout(location=3) in float a_stroke;
        uniform mat3 u_view;
        uniform vec2 u_viewportPx;
        out vec2 v_local;
        out vec2 v_size;
        out vec4 v_color;
        out float v_stroke;
        void main() {
          vec2 world = a_rect.xy + a_uv * a_rect.zw;
          vec2 screen = (u_view * vec3(world, 1.0)).xy;
          v_local = a_uv * a_rect.zw;
          v_size = a_rect.zw;
          v_color = a_color;
          v_stroke = a_stroke;
          vec2 ndc = (screen / u_viewportPx) * 2.0 - 1.0;
          ndc.y = -ndc.y;
          gl_Position = vec4(ndc, 0.0, 1.0);
        }`,
        `#version 300 es
        precision highp float;
        in vec2 v_local;
        in vec2 v_size;
        in vec4 v_color;
        in float v_stroke;
        out vec4 outColor;
        void main() {
          float edgeDist = min(min(v_local.x, v_local.y), min(v_size.x - v_local.x, v_size.y - v_local.y));
          float aa = max(1.0, fwidth(edgeDist));
          float a = 1.0 - smoothstep(v_stroke - aa, v_stroke + aa, edgeDist);
          if (a < 0.001) discard;
          outColor = vec4(v_color.rgb, v_color.a * a);
        }`
      );
      this.rectBuffer = gl.createBuffer();
    }

    const data = new Float32Array(rects.length * 9);
    let o = 0;
    for (const r of rects) {
      data[o++] = r.x;
      data[o++] = r.y;
      data[o++] = r.width;
      data[o++] = r.height;
      data[o++] = r.color[0];
      data[o++] = r.color[1];
      data[o++] = r.color[2];
      data[o++] = r.color[3];
      data[o++] = r.strokePx;
    }

    gl.useProgram(this.rectProgram);
    gl.bindVertexArray(this.baseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.rectProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.rectProgram, "u_viewportPx"), width, height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rects.length);
  }

  _drawPortBatch(textureInfo, instances, width, height, view) {
    if (!instances.length) return;
    const gl = this.gl;
    gl.useProgram(this.spriteProgram);
    gl.bindVertexArray(this.baseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);

    const stride = 8 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.disableVertexAttribArray(3);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textureInfo.texture);
    gl.uniform1i(gl.getUniformLocation(this.spriteProgram, "u_tex"), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.spriteProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.spriteProgram, "u_viewportPx"), width, height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.length / 8);
  }

  _drawPorts(nodes, edges, posById, width, height, view) {
    if (!this.portTextures) return;
    const cfg = this.assets.ports;
    const iconSize = Number(cfg.iconSizePx) || 12;
    const half = iconSize * 0.5;
    const uvRect = [0, 0, 1, 1];

    const outputUsage = new Set();
    for (const edge of edges) {
      outputUsage.add(`${edge.from}:${edge.fromOutputId}`);
    }

    const emptyInstances = [];
    const fullInstances = [];
    const pushInstance = (target, cx, cy) => {
      target.push(cx - half, cy - half, iconSize, iconSize);
      target.push(uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
    };

    for (const node of nodes) {
      const pos = posById.get(node.id);
      if (!pos) continue;

      for (let i = 0; i < node.inputCount; i++) {
        const input = node.inputs[i];
        const p = this._getPortCenter(node, pos, true, i);
        if (input?.srcNodeId) {
          pushInstance(fullInstances, p.x, p.y);
        } else {
          pushInstance(emptyInstances, p.x, p.y);
        }
      }

      for (let i = 0; i < node.outputCount; i++) {
        const output = node.outputs[i];
        const p = this._getPortCenter(node, pos, false, i);
        if (output && outputUsage.has(`${node.id}:${output.outputId}`)) {
          pushInstance(fullInstances, p.x, p.y);
        } else {
          pushInstance(emptyInstances, p.x, p.y);
        }
      }
    }

    this._drawPortBatch(this.portTextures.empty, new Float32Array(emptyInstances), width, height, view);
    this._drawPortBatch(this.portTextures.full, new Float32Array(fullInstances), width, height, view);
  }

  _drawNodes(nodes, posById, width, height, view) {
    const gl = this.gl;
    if (!nodes.length || !this.skinTexture) return;

    const data = new Float32Array(nodes.length * 4);
    let o = 0;
    for (const node of nodes) {
      const pos = posById.get(node.id);
      const nodeSize = this._getNodeSize(node);
      data[o++] = pos.x;
      data[o++] = pos.y;
      data[o++] = nodeSize.width;
      data[o++] = nodeSize.height;
    }

    gl.useProgram(this.nodeProgram);
    gl.bindVertexArray(this.baseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.skinTexture.texture);
    gl.uniform1i(gl.getUniformLocation(this.nodeProgram, "u_skin"), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.nodeProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.nodeProgram, "u_viewportPx"), width, height);
    gl.uniform2f(gl.getUniformLocation(this.nodeProgram, "u_skinSize"), this.skinTexture.width, this.skinTexture.height);
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
    const cMuted = this.assets.theme.textMuted || c;

    gl.useProgram(this.textProgram);
    gl.bindVertexArray(this.baseVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textAtlas.texture);
    gl.uniform1i(gl.getUniformLocation(this.textProgram, "u_tex"), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.textProgram, "u_view"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.textProgram, "u_viewport"), width, height);
    const colorLoc = gl.getUniformLocation(this.textProgram, "u_color");
    gl.uniform4f(colorLoc, c[0], c[1], c[2], c[3]);
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

    const atlasSize = Math.max(1, this.textAtlas.atlasSize || 48);
    const titlePx = Number(this.assets.text.fontPx || 14);
    const portPx = Number(this.assets.ports.labelFontPx || 11);
    const titleScale = titlePx / atlasSize;
    const portScale = portPx / atlasSize;

    const measureTextWidth = (text, scale) => {
      let widthPx = 0;
      for (const ch of text) {
        const g = glyphs.get(ch.codePointAt(0));
        if (!g) {
          widthPx += atlasSize * 0.3 * scale;
          continue;
        }
        widthPx += g.advancePx * scale;
      }
      return widthPx;
    };

    const drawText = (text, startX, baselineY, scale) => {
      let x = startX;
      for (const ch of text) {
        const g = glyphs.get(ch.codePointAt(0));
        if (!g) {
          x += atlasSize * 0.3 * scale;
          continue;
        }
        if (g.empty) {
          x += g.advancePx * scale;
          continue;
        }
        const gw = g.widthPx * scale;
        const gh = g.heightPx * scale;
        const px = x + g.offsetXPx * scale;
        const py = baselineY + g.baselineOffsetYPx * scale;
        gl.uniform2f(gl.getUniformLocation(this.textProgram, "uP"), px, py);
        gl.uniform4f(gl.getUniformLocation(this.textProgram, "uT"), gw * 0.5, 0, 0, gh * 0.5);
        gl.uniform4f(gl.getUniformLocation(this.textProgram, "u_uv"), g.uv[0], g.uv[1], g.uv[2], g.uv[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        x += g.advancePx * scale;
      }
    };

    const iconHalf = Number(this.assets.ports.iconSizePx || 12) * 0.5;
    const labelOffset = Number(this.assets.ports.labelOffsetX || 10);
    const padX = Number(this.assets.layout.nodePaddingX || 10);

    for (const node of nodes) {
      const pos = posById.get(node.id);
      const nodeSize = this._getNodeSize(node);
      const kindLabel = node.kind === NG.NODE_CODE
        ? "code"
        : node.kind === NG.NODE_GOAL
          ? "goal"
          : node.kind === NG.NODE_VALUE
            ? "value"
            : "node";
      const labelA = `${kindLabel} #${node.id}`;
      const labelState = `state ${node.execState}`;
      const x = pos.x + padX;
      const yA = pos.y + titlePx + 2;

      gl.uniform4f(colorLoc, c[0], c[1], c[2], c[3]);
      drawText(labelA, x, yA, titleScale);

      const stateWidth = measureTextWidth(labelState, portScale);
      const stateX = Math.max(x + 56, pos.x + nodeSize.width - padX - stateWidth);
      gl.uniform4f(colorLoc, cMuted[0], cMuted[1], cMuted[2], cMuted[3]);
      drawText(labelState, stateX, yA, portScale);

      for (let i = 0; i < node.inputCount; i++) {
        const inputId = node.inputs[i]?.inputId ?? i + 1;
        const label = this._getPortLabel(node.id, "input", inputId, i);
        const p = this._getPortCenter(node, pos, true, i);
        const baselineY = p.y + portPx * 0.35;
        const startX = p.x + iconHalf + labelOffset;
        drawText(label, startX, baselineY, portScale);
      }

      for (let i = 0; i < node.outputCount; i++) {
        const outputId = node.outputs[i]?.outputId ?? i + 1;
        const label = this._getPortLabel(node.id, "output", outputId, i);
        const p = this._getPortCenter(node, pos, false, i);
        const baselineY = p.y + portPx * 0.35;
        const labelWidth = measureTextWidth(label, portScale);
        const endX = p.x - iconHalf - labelOffset;
        drawText(label, endX - labelWidth, baselineY, portScale);
      }

    }
  }

  _emitSelectionChanged() {
    this.dispatchEvent(new CustomEvent("ng-selection-change", {
      bubbles: true,
      composed: true,
      detail: { selectedNodeIds: this.getSelectedNodeIds() },
    }));
  }
}

if (!customElements.get("node-graph-canvas")) {
  customElements.define("node-graph-canvas", NodeGraphCanvasElement);
}

export { NodeGraphCanvasElement };
