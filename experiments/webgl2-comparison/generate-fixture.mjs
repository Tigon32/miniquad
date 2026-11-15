#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WIDTH = 640;
const HEIGHT = 400;
const GRID_SIZE = 24;
const LEVEL_LIMIT = 7;
const CELL_COUNT = 152;
const LEVEL_COUNT = 686;
const PATH_POINT_COUNT = 180;
const ARROW_COUNT = 20;
const BACKGROUND = [5, 8, 22, 255];
const COLORS = {
  grid: [32, 49, 75, 255],
  voxelTop: [23, 228, 255, 255],
  voxelLeft: [8, 124, 186, 255],
  voxelRight: [109, 53, 255, 255],
  path: [255, 73, 198, 255],
  arrow: [255, 243, 107, 255],
};

function project(q, r, z = 0) {
  return [
    WIDTH / 2 + (q - r) * 11,
    285 - (q + r) * 4.5 - z * 8.5,
  ];
}

function toNdc([x, y]) {
  const scaledX = Math.fround(x / WIDTH);
  const scaledY = Math.fround(y / HEIGHT);
  return [
    Math.fround(Math.fround(scaledX * 2) - 1),
    Math.fround(1 - Math.fround(scaledY * 2)),
  ];
}

function colorToFloat(color) {
  return color.map((value) => Math.fround(value / 255));
}

function addTriangle(vertices, indices, points, color) {
  const first = vertices.length / 6;
  for (const point of points) {
    vertices.push(...toNdc(point), ...colorToFloat(color));
  }
  indices.push(first, first + 1, first + 2);
}

function addPolyline(vertices, indices, points, width, color) {
  const half = Math.fround(width / 2);
  const rgba = colorToFloat(color);
  for (let point = 0; point + 1 < points.length; point += 1) {
    const [x0, y0] = points[point];
    const [x1, y1] = points[point + 1];
    const dx = Math.fround(x1 - x0);
    const dy = Math.fround(y1 - y0);
    const length = Math.fround(Math.sqrt(Math.fround(
      Math.fround(dx * dx) + Math.fround(dy * dy)
    )));
    if (length === 0) continue;
    const nx = Math.fround(Math.fround(-dy / length) * half);
    const ny = Math.fround(Math.fround(dx / length) * half);
    const first = vertices.length / 6;
    for (const [x, y] of [
      [Math.fround(x0 + nx), Math.fround(y0 + ny)],
      [Math.fround(x0 - nx), Math.fround(y0 - ny)],
      [Math.fround(x1 + nx), Math.fround(y1 + ny)],
      [Math.fround(x1 - nx), Math.fround(y1 - ny)],
    ]) {
      vertices.push(...toNdc([x, y]), ...rgba);
    }
    indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
  }
}

function voxelFaceCorners(x, y, z, normal) {
  const local = {
    "1,0,0": [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    "-1,0,0": [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
    "0,1,0": [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    "0,-1,0": [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
    "0,0,1": [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
    "0,0,-1": [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  }[normal.join(",")];
  return local.map(([lx, ly, lz]) => [x + lx, y + ly, z + lz]);
}

function addVoxelLayer(vertices, indices, cells) {
  const heights = new Map(cells.map(({ q, r, height }) => [`${q},${r}`, height]));
  const solid = (x, y, z) => (heights.get(`${x},${y}`) || 0) > z;
  const faces = [
    { direction: [1, 0, 0], color: COLORS.voxelRight },
    { direction: [-1, 0, 0] },
    { direction: [0, 1, 0] },
    { direction: [0, -1, 0], color: COLORS.voxelLeft },
    { direction: [0, 0, 1], color: COLORS.voxelTop },
    { direction: [0, 0, -1] },
  ];
  for (let z = 0; z < LEVEL_LIMIT; z += 1) {
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        if (!solid(x, y, z)) continue;
        for (const face of faces) {
          const [dx, dy, dz] = face.direction;
          if (solid(x + dx, y + dy, z + dz) || !face.color) continue;
          const first = vertices.length / 6;
          for (const point of voxelFaceCorners(x, y, z, face.direction)) {
            const pixel = [
              Math.fround(320 + Math.fround((point[0] - point[1]) * 11)),
              Math.fround(393 - Math.fround(Math.fround(point[0] + point[1]) * 4.5)
                - Math.fround(point[2] * 8.5)),
            ];
            vertices.push(...toNdc(pixel), ...colorToFloat(face.color));
          }
          indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        }
      }
    }
  }
}

function buildCells() {
  const cells = [];
  for (let q = 0; q < GRID_SIZE; q += 1) {
    for (let r = 0; r < GRID_SIZE; r += 1) {
      const x = q - (GRID_SIZE - 1) / 2;
      const y = r - (GRID_SIZE - 1) / 2;
      cells.push({ q, r, score: x * x + y * y });
    }
  }
  cells.sort((a, b) => a.score - b.score || a.q - b.q || a.r - b.r);
  const occupied = cells.slice(0, CELL_COUNT);
  const heights = occupied.map(({ q, r }) => 1 + ((q * 13 + r * 7 + 2026) % LEVEL_LIMIT));
  let total = heights.reduce((sum, height) => sum + height, 0);
  let index = 0;
  while (total < LEVEL_COUNT) {
    if (heights[index] < LEVEL_LIMIT) {
      heights[index] += 1;
      total += 1;
    }
    index = (index + 1) % heights.length;
  }
  while (total > LEVEL_COUNT) {
    if (heights[index] > 1) {
      heights[index] -= 1;
      total -= 1;
    }
    index = (index + 1) % heights.length;
  }
  return occupied
    .map(({ q, r }, cellIndex) => ({ q, r, height: heights[cellIndex] }))
    .sort((a, b) => a.q + a.r - (b.q + b.r) || a.q - b.q || a.r - b.r);
}

export function buildFixture() {
  const vertices = [];
  const indices = [];
  const layers = {};
  const cells = buildCells();

  layers.grid = { firstIndex: 0 };
  for (let q = 0; q <= GRID_SIZE; q += 1) {
    addPolyline(vertices, indices, [project(q - 12, -12), project(q - 12, 12)], 1.2, COLORS.grid);
  }
  for (let r = 0; r <= GRID_SIZE; r += 1) {
    addPolyline(vertices, indices, [project(-12, r - 12), project(12, r - 12)], 1.2, COLORS.grid);
  }
  layers.grid.indexCount = indices.length - layers.grid.firstIndex;

  layers.voxels = { firstIndex: indices.length };
  addVoxelLayer(vertices, indices, cells);
  layers.voxels.indexCount = indices.length - layers.voxels.firstIndex;

  const path = Array.from({ length: PATH_POINT_COUNT }, (_, pointIndex) => {
    const t = pointIndex / (PATH_POINT_COUNT - 1);
    const x = 60 + t * 520;
    const y = 78 + Math.sin(t * Math.PI * 4) * 24 + Math.sin(t * Math.PI * 10) * 8;
    return [Math.fround(x), Math.fround(y)];
  });
  layers.vectors = { firstIndex: indices.length };
  addPolyline(vertices, indices, path, 3, COLORS.path);
  const arrows = [];
  for (let arrow = 0; arrow < ARROW_COUNT; arrow += 1) {
    const pointIndex = Math.floor((arrow + 1) * (PATH_POINT_COUNT - 1) / (ARROW_COUNT + 1));
    const from = path[pointIndex];
    const to = path[pointIndex + 1];
    const dx = Math.fround(to[0] - from[0]);
    const dy = Math.fround(to[1] - from[1]);
    const length = Math.fround(Math.sqrt(Math.fround(
      Math.fround(dx * dx) + Math.fround(dy * dy)
    )));
    const ux = Math.fround(dx / length);
    const uy = Math.fround(dy / length);
    const base = [
      Math.fround(to[0] - Math.fround(ux * 10)),
      Math.fround(to[1] - Math.fround(uy * 10)),
    ];
    const left = [
      Math.fround(base[0] - Math.fround(uy * 5)),
      Math.fround(base[1] + Math.fround(ux * 5)),
    ];
    const right = [
      Math.fround(base[0] + Math.fround(uy * 5)),
      Math.fround(base[1] - Math.fround(ux * 5)),
    ];
    addTriangle(vertices, indices, [to, left, right], COLORS.arrow);
    arrows.push({ pointIndex, sample: [
      Math.round((to[0] + left[0] + right[0]) / 3),
      Math.round((to[1] + left[1] + right[1]) / 3),
    ] });
  }
  layers.vectors.indexCount = indices.length - layers.vectors.firstIndex;

  const voxelSample = cells[Math.floor(cells.length / 2)];
  const voxelPoint = [
    320 + (voxelSample.q - voxelSample.r) * 11,
    393 - (voxelSample.q + voxelSample.r + 1) * 4.5 - voxelSample.height * 8.5,
  ];
  const visualChecks = [
    { layer: "grid", sample: [450, 339], color: COLORS.grid },
    { layer: "voxels", sample: [Math.round(voxelPoint[0]), Math.round(voxelPoint[1])], color: COLORS.voxelTop },
    { layer: "path", sample: [Math.round(path[90][0]), Math.round(path[90][1])], color: COLORS.path },
    { layer: "arrow", sample: arrows[10].sample, color: COLORS.arrow },
    { layer: "background", sample: [12, 12], color: BACKGROUND },
  ];
  const absentChecks = [
    { layer: "samplePoints", sample: [80, 150], color: BACKGROUND },
  ];

  return {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    gridSize: GRID_SIZE,
    levelLimit: LEVEL_LIMIT,
    simulatedTime: 0,
    schema: {
      coordinateOrder: "q, r, then z",
      cellCoordinates: "zero-based integer grid cells",
      levelMeaning: "height is the number of occupied unit voxels along +z",
      numericEncoding: "JSON numbers; submitted geometry is IEEE-754 binary32 and indices are unsigned 16-bit little-endian",
      units: "cell coordinates use grid units; drawing geometry uses logical pixels with a top-left origin",
      colors: "straight-alpha RGBA8; alpha is opaque",
    },
    background: BACKGROUND,
    counts: {
      occupiedCells: cells.length,
      voxelLevels: cells.reduce((sum, cell) => sum + cell.height, 0),
      pathPoints: path.length,
      arrows: arrows.length,
      vectorItems: path.length + arrows.length,
    },
    cells,
    path,
    arrows: arrows.map(({ pointIndex }) => pointIndex),
    layers,
    visualChecks,
    absentChecks,
    vertices,
    indices,
  };
}

function rustFloat(value) {
  if (!Number.isFinite(value)) throw new Error("fixture contains a non-finite float");
  return `${Math.fround(value)}f32`;
}

function generateRust(fixture) {
  const lines = [
    "#[repr(C)]",
    "#[derive(Clone, Copy, PartialEq)]",
    "pub struct Vertex {",
    "    pub position: [f32; 2],",
    "    pub color: [f32; 4],",
    "}",
    "",
    "#[derive(Clone, Copy, Debug, PartialEq)]",
    "pub struct Layer {",
    "    pub first_index: i32,",
    "    pub index_count: i32,",
    "}",
    "",
    `pub const MESH_FNV64: u64 = 0x${fixture.meshFnv64}u64;`,
    `pub const WIDTH: u32 = ${fixture.width};`,
    `pub const HEIGHT: u32 = ${fixture.height};`,
    `pub const BACKGROUND: [u8; 4] = [${fixture.background.join(", ")}];`,
    `pub const OCCUPIED_CELLS: u32 = ${fixture.counts.occupiedCells};`,
    `pub const VOXEL_LEVELS: u32 = ${fixture.counts.voxelLevels};`,
    `pub const PATH_POINTS: u32 = ${fixture.counts.pathPoints};`,
    `pub const ARROWS: u32 = ${fixture.counts.arrows};`,
    `pub const VECTOR_ITEMS: u32 = ${fixture.counts.vectorItems};`,
    `pub const GRID_SIZE: u32 = ${fixture.gridSize};`,
    `pub const LEVEL_LIMIT: u32 = ${fixture.levelLimit};`,
    "",
    "#[derive(Clone, Copy)]",
    "pub struct Cell {",
    "    pub q: u32,",
    "    pub r: u32,",
    "    pub height: u32,",
    "}",
    "",
    "pub const CELLS: &[Cell] = &[",
    ...fixture.cells.map(({ q, r, height }) => `    Cell { q: ${q}, r: ${r}, height: ${height} },`),
    "];",
    "",
    "pub const PATH: &[[f32; 2]] = &[",
    ...fixture.path.map(([x, y]) => `    [${rustFloat(x)}, ${rustFloat(y)}],`),
    "];",
    "",
    "pub const ARROW_POINTS: &[u32] = &[",
    `    ${fixture.arrows.join(", ")},`,
    "];",
    "",
    "pub const VERTICES: &[Vertex] = &[",
  ];
  for (let index = 0; index < fixture.vertices.length; index += 6) {
    const [x, y, r, g, b, a] = fixture.vertices.slice(index, index + 6);
    lines.push(`    Vertex { position: [${rustFloat(x)}, ${rustFloat(y)}], color: [${rustFloat(r)}, ${rustFloat(g)}, ${rustFloat(b)}, ${rustFloat(a)}] },`);
  }
  lines.push("];", "", "pub const INDICES: &[u16] = &[");
  for (let index = 0; index < fixture.indices.length; index += 12) {
    lines.push(`    ${fixture.indices.slice(index, index + 12).join(", ")},`);
  }
  lines.push("];", "", "pub const LAYERS: [Layer; 3] = [");
  for (const name of ["grid", "voxels", "vectors"]) {
    const layer = fixture.layers[name];
    lines.push(`    Layer { first_index: ${layer.firstIndex}, index_count: ${layer.indexCount} },`);
  }
  lines.push("];");
  return `${lines.join("\n")}\n`;
}

function meshFnv64(fixture) {
  let hash = 0xcbf29ce484222325n;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  const update = (byte) => {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  };
  for (const value of fixture.vertices) {
    view.setFloat32(0, Math.fround(value), true);
    for (const byte of new Uint8Array(buffer)) update(byte);
  }
  for (const value of fixture.indices) {
    update(value & 0xff);
    update((value >>> 8) & 0xff);
  }
  return hash.toString(16).padStart(16, "0");
}

export function writeFixture() {
  const fixture = buildFixture();
  const meshHash = createHash("sha256");
  const bytes = Buffer.alloc(fixture.vertices.length * 4 + fixture.indices.length * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (const value of fixture.vertices) {
    view.setFloat32(offset, Math.fround(value), true);
    offset += 4;
  }
  for (const value of fixture.indices) {
    view.setUint16(offset, value, true);
    offset += 2;
  }
  meshHash.update(bytes);
  fixture.meshSha256 = meshHash.digest("hex");
  fixture.meshFnv64 = meshFnv64(fixture);
  const finalJson = `${JSON.stringify(fixture, null, 2)}\n`;
  const finalHash = createHash("sha256").update(finalJson).digest("hex");
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "fixture.json"), finalJson);
  writeFileSync(join(ROOT, "fixture.rs"), generateRust(fixture));
  writeFileSync(join(ROOT, "fixture.sha256"), `${finalHash}  fixture.json\n`);
  return { sourceHash: finalHash, meshSha256: fixture.meshSha256 };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = writeFixture();
  console.log(`Fixture SHA-256: ${result.sourceHash}`);
  console.log(`Mesh SHA-256: ${result.meshSha256}`);
}
