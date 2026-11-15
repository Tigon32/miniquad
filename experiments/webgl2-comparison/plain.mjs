function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 did not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL2 did not create a program");
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

const SCENE_VERTEX = `#version 300 es
in vec2 in_pos;
in vec4 in_color;
out lowp vec4 color;
void main() {
  gl_Position = vec4(in_pos, 0.0, 1.0);
  color = in_color;
}`;

const SCENE_FRAGMENT = `#version 300 es
precision mediump float;
in lowp vec4 color;
out vec4 frag_color;
void main() {
  frag_color = color;
}`;

const DISPLAY_VERTEX = `#version 300 es
in vec2 in_pos;
in vec2 in_uv;
out lowp vec2 uv;
void main() {
  gl_Position = vec4(in_pos, 0.0, 1.0);
  uv = in_uv;
}`;

const DISPLAY_FRAGMENT = `#version 300 es
precision mediump float;
in lowp vec2 uv;
uniform sampler2D tex;
out vec4 frag_color;
void main() {
  frag_color = texture(tex, uv);
}`;

function meshHash(vertices, indices) {
  let hash = 0xcbf29ce484222325n;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  const update = (byte) => {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  };
  for (const value of vertices) {
    view.setFloat32(0, value, true);
    for (const byte of new Uint8Array(buffer)) update(byte);
  }
  for (const index of indices) {
    update(index & 0xff);
    update((index >>> 8) & 0xff);
  }
  return hash.toString(16).padStart(16, "0");
}

function makeSceneMesh(gl, fixture) {
  const vao = gl.createVertexArray();
  const vertices = gl.createBuffer();
  const indices = gl.createBuffer();
  if (!vao || !vertices || !indices) throw new Error("WebGL2 did not create scene buffers");
  const vertexData = new Float32Array(fixture.vertices);
  const indexData = new Uint16Array(fixture.indices);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
  gl.bindVertexArray(null);
  const counts = {
    occupiedCells: fixture.cells.length,
    voxelLevels: fixture.cells.reduce((total, cell) => total + cell.height, 0),
    pathPoints: fixture.path.length,
    arrows: fixture.arrows.length,
    vectorItems: fixture.path.length + fixture.arrows.length,
  };
  return {
    vao,
    vertices,
    indices,
    metadata: {
      ...counts,
      meshFnv64: meshHash(vertexData, indexData),
      vertexCount: vertexData.length / 6,
      indexCount: indexData.length,
    },
  };
}

function makeDisplayMesh(gl) {
  const vao = gl.createVertexArray();
  const vertices = gl.createBuffer();
  const indices = gl.createBuffer();
  if (!vao || !vertices || !indices) throw new Error("WebGL2 did not create display buffers");
  const data = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    1, 1, 1, 1,
    -1, 1, 0, 1,
  ]);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);
  return { vao, vertices, indices };
}

function setupTarget(gl, width, height) {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error("WebGL2 did not create an offscreen target");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("WebGL2 comparison framebuffer is incomplete");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer };
}

async function start() {
  const fixture = await fetch("/fixture.json", { cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
    return response.json();
  });
  const canvas = document.querySelector("#glcanvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("WebGL2 context is unavailable");
  window.gl = gl;
  if ("drawingBufferColorSpace" in gl) gl.drawingBufferColorSpace = "srgb";

  const sceneProgram = createProgram(gl, SCENE_VERTEX, SCENE_FRAGMENT);
  const displayProgram = createProgram(gl, DISPLAY_VERTEX, DISPLAY_FRAGMENT);
  const sceneMesh = makeSceneMesh(gl, fixture);
  const displayMesh = makeDisplayMesh(gl);
  const target = setupTarget(gl, fixture.width, fixture.height);
  const sceneLayerLocation = gl.getAttribLocation(sceneProgram, "in_pos");
  const colorLocation = gl.getAttribLocation(sceneProgram, "in_color");
  const displayLocation = gl.getAttribLocation(displayProgram, "in_pos");
  const uvLocation = gl.getAttribLocation(displayProgram, "in_uv");
  const samplerLocation = gl.getUniformLocation(displayProgram, "tex");
  let layerMask = 0b111;
  let knownBad = false;

  function draw() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, fixture.width, fixture.height);
    gl.clearColor(
      fixture.background[0] / 255,
      fixture.background[1] / 255,
      fixture.background[2] / 255,
      fixture.background[3] / 255
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(sceneProgram);
    gl.bindVertexArray(sceneMesh.vao);
    gl.enableVertexAttribArray(sceneLayerLocation);
    gl.enableVertexAttribArray(colorLocation);
    for (const [index, layer] of Object.entries(fixture.layers)) {
      const layerIndex = index === "grid" ? 0 : index === "voxels" ? 1 : 2;
      if (layerMask & (1 << layerIndex)) {
        gl.drawElements(
          gl.TRIANGLES,
          layer.indexCount,
          gl.UNSIGNED_SHORT,
          layer.firstIndex * Uint16Array.BYTES_PER_ELEMENT
        );
      }
    }

    if (knownBad) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, fixture.height - 32, 32, 32);
      gl.clearColor(1, 0, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, fixture.width, fixture.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(displayProgram);
    gl.bindVertexArray(displayMesh.vao);
    gl.enableVertexAttribArray(displayLocation);
    gl.enableVertexAttribArray(uvLocation);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(samplerLocation, 0);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  window.__comparisonArm = "plain-webgl2";
  window.__comparisonFixture = fixture;
  window.__comparisonMeshInfo = () => sceneMesh.metadata;
  window.__comparisonSetLayerMask = (mask) => {
    layerMask = mask & 0b111;
  };
  window.__comparisonPlainSetKnownBad = (enabled) => {
    knownBad = enabled;
  };
  window.__comparisonReadTargetPixels = () => {
    const pixels = new Uint8Array(fixture.width * fixture.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, fixture.width, fixture.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const rowBytes = fixture.width * 4;
    for (let row = 0; row < fixture.height / 2; row += 1) {
      const opposite = fixture.height - row - 1;
      for (let byte = 0; byte < rowBytes; byte += 1) {
        const first = row * rowBytes + byte;
        const second = opposite * rowBytes + byte;
        [pixels[first], pixels[second]] = [pixels[second], pixels[first]];
      }
    }
    return pixels;
  };
  window.__comparisonFrame = draw;
  window.__comparisonReady = true;
  draw();
  window.requestAnimationFrame(function frame() {
    draw();
    window.requestAnimationFrame(frame);
  });
}

start().catch((error) => {
  window.__comparisonError = String(error);
  console.error(error);
});
