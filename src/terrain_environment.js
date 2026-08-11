import * as THREE from 'three';
import { createTerrainGeometryData } from './terrain_grid_geometry.mjs?v=r2-20260809-6';

export const TERRAIN_GRID_ENVIRONMENT_VERSION = 1;

function colorFromConfig(value, fallback) {
  try {
    return new THREE.Color(value ?? fallback);
  } catch (_error) {
    return new THREE.Color(fallback);
  }
}

function buildElevationColors(heightFractions, materialConfig) {
  const low = colorFromConfig(materialConfig.lowColor, 0x315d45);
  const middle = colorFromConfig(materialConfig.middleColor, 0x9d895f);
  const high = colorFromConfig(materialConfig.highColor, 0xe7e2d2);
  const colors = new Float32Array(heightFractions.length * 3);
  for (let index = 0; index < heightFractions.length; index += 1) {
    const value = heightFractions[index];
    const color = value <= 0.5
      ? low.clone().lerp(middle, value * 2)
      : middle.clone().lerp(high, (value - 0.5) * 2);
    const offset = index * 3;
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
  }
  return colors;
}

export async function buildTerrainGridEnvironment(envCfg) {
  const terrainGridPath = envCfg?.terrainGridPath;
  if (typeof terrainGridPath !== 'string' || terrainGridPath.length === 0) {
    throw new Error('[TerrainEnvironment] terrainGridPath is required');
  }
  const response = await fetch(terrainGridPath);
  if (!response.ok) {
    throw new Error(`[TerrainEnvironment] failed to load terrain grid: ${terrainGridPath}`);
  }
  const geometryData = createTerrainGeometryData(await response.json());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(geometryData.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(geometryData.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(geometryData.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const materialConfig = envCfg.material ?? {};
  const materialMode = materialConfig.mode ?? 'elevation';
  const usesVertexColors = materialMode === 'elevation';
  if (usesVertexColors) {
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(
        buildElevationColors(geometryData.heightFractions, materialConfig),
        3,
      ),
    );
  }
  const material = new THREE.MeshStandardMaterial({
    color: usesVertexColors
      ? 0xffffff
      : colorFromConfig(materialConfig.color, 0x708060),
    vertexColors: usesVertexColors,
    wireframe: materialMode === 'wireframe' || materialConfig.wireframe === true,
    roughness: Number(materialConfig.roughness ?? 0.92),
    metalness: Number(materialConfig.metalness ?? 0.0),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${envCfg.name ?? 'terrain'}_mesh`;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = envCfg.name ?? 'terrain';
  group.add(mesh);

  const debug = envCfg.debug ?? {};
  const diagnostics = {
    name: envCfg.name ?? 'terrain',
    type: 'terrain-grid',
    status: 'ready',
    source: terrainGridPath,
    materialMode,
    wireframe: material.wireframe,
    ...geometryData.diagnostics,
  };
  const xSize = geometryData.diagnostics.columns > 1
    ? Math.abs(geometryData.positions[(geometryData.diagnostics.columns - 1) * 3 + 2]
      - geometryData.positions[2])
    : 0;
  const lastRowOffset = (geometryData.diagnostics.rows - 1)
    * geometryData.diagnostics.columns * 3;
  const ySize = Math.abs(geometryData.positions[lastRowOffset]
    - geometryData.positions[0]);
  if (debug.grid === true) {
    const helperSize = Math.max(xSize, ySize);
    const divisions = Math.max(2, Number(debug.gridDivisions ?? 20));
    const grid = new THREE.GridHelper(helperSize, divisions, 0x334155, 0x64748b);
    grid.name = `${group.name}_debug_grid`;
    group.add(grid);
  }
  if (debug.axes === true) {
    const axes = new THREE.AxesHelper(Number(debug.axesSizeM ?? 25));
    axes.name = `${group.name}_debug_axes`;
    group.add(axes);
  }
  group.userData.terrainDiagnostics = diagnostics;
  return { object3d: group, diagnostics };
}
