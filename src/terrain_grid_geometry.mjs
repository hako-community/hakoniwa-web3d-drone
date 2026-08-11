export const TERRAIN_GRID_SCHEMA_VERSION = 1;
export const TERRAIN_GRID_FRAME = 'mujoco_x_north_y_minus_east_z_up';

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`[TerrainGrid] ${label} must be finite`);
  }
  return number;
}

export function validateTerrainGrid(data) {
  if (!data || data.schemaVersion !== TERRAIN_GRID_SCHEMA_VERSION) {
    throw new Error('[TerrainGrid] unsupported schemaVersion');
  }
  if (data.frame !== TERRAIN_GRID_FRAME) {
    throw new Error(`[TerrainGrid] unsupported frame: ${data.frame}`);
  }
  const rows = Number(data.rows);
  const columns = Number(data.columns);
  if (!Number.isInteger(rows) || rows < 2 || !Number.isInteger(columns) || columns < 2) {
    throw new Error('[TerrainGrid] rows and columns must be integers >= 2');
  }
  const xMinM = finiteNumber(data.xMinM, 'xMinM');
  const xMaxM = finiteNumber(data.xMaxM, 'xMaxM');
  const yMinM = finiteNumber(data.yMinM, 'yMinM');
  const yMaxM = finiteNumber(data.yMaxM, 'yMaxM');
  const zBaselineM = finiteNumber(data.zBaselineM, 'zBaselineM');
  if (xMinM >= xMaxM || yMinM >= yMaxM) {
    throw new Error('[TerrainGrid] coordinate bounds must be increasing');
  }
  if (!Array.isArray(data.modelHeightsM) || data.modelHeightsM.length !== rows * columns) {
    throw new Error('[TerrainGrid] modelHeightsM length must equal rows * columns');
  }
  const heights = data.modelHeightsM.map((value, index) =>
    finiteNumber(value, `modelHeightsM[${index}]`)
  );
  return {
    schemaVersion: TERRAIN_GRID_SCHEMA_VERSION,
    frame: TERRAIN_GRID_FRAME,
    rows,
    columns,
    xMinM,
    xMaxM,
    yMinM,
    yMaxM,
    zBaselineM,
    modelHeightsM: heights,
  };
}

export function createTerrainGeometryData(input) {
  const grid = validateTerrainGrid(input);
  const vertexCount = grid.rows * grid.columns;
  const triangleCount = (grid.rows - 1) * (grid.columns - 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const heightFractions = new Float32Array(vertexCount);
  const indices = vertexCount > 65535
    ? new Uint32Array(triangleCount * 3)
    : new Uint16Array(triangleCount * 3);
  const xStep = (grid.xMaxM - grid.xMinM) / (grid.columns - 1);
  const yStep = (grid.yMaxM - grid.yMinM) / (grid.rows - 1);
  let minimumModelHeightM = Infinity;
  let maximumModelHeightM = -Infinity;

  for (let row = 0; row < grid.rows; row += 1) {
    const rosY = grid.yMinM + row * yStep;
    for (let column = 0; column < grid.columns; column += 1) {
      const rosX = grid.xMinM + column * xStep;
      const vertex = row * grid.columns + column;
      const height = grid.modelHeightsM[vertex];
      minimumModelHeightM = Math.min(minimumModelHeightM, height);
      maximumModelHeightM = Math.max(maximumModelHeightM, height);
      const positionOffset = vertex * 3;
      // Hakoniwa/ROS [x, y, z] -> Three.js [-y, z, -x].
      positions[positionOffset] = -rosY;
      positions[positionOffset + 1] = height;
      positions[positionOffset + 2] = -rosX;
      const uvOffset = vertex * 2;
      uvs[uvOffset] = column / (grid.columns - 1);
      uvs[uvOffset + 1] = row / (grid.rows - 1);
    }
  }

  const elevationRangeM = maximumModelHeightM - minimumModelHeightM;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const height = grid.modelHeightsM[vertex];
    heightFractions[vertex] = elevationRangeM > 0
      ? (height - minimumModelHeightM) / elevationRangeM
      : 0;
  }

  let indexOffset = 0;
  for (let row = 0; row < grid.rows - 1; row += 1) {
    for (let column = 0; column < grid.columns - 1; column += 1) {
      const p00 = row * grid.columns + column;
      const p10 = p00 + 1;
      const p01 = p00 + grid.columns;
      const p11 = p01 + 1;
      // Winding is chosen so a flat grid has a +Y normal in Three.js.
      indices[indexOffset] = p00;
      indices[indexOffset + 1] = p10;
      indices[indexOffset + 2] = p01;
      indices[indexOffset + 3] = p10;
      indices[indexOffset + 4] = p11;
      indices[indexOffset + 5] = p01;
      indexOffset += 6;
    }
  }

  return {
    positions,
    uvs,
    heightFractions,
    indices,
    diagnostics: {
      schemaVersion: grid.schemaVersion,
      frame: grid.frame,
      rows: grid.rows,
      columns: grid.columns,
      vertexCount,
      triangleCount,
      minimumModelHeightM,
      maximumModelHeightM,
      zBaselineM: grid.zBaselineM,
      usesZBaselineInGeometry: false,
      positionTransform: '[rosX, rosY, modelZ] -> [-rosY, modelZ, -rosX]',
    },
  };
}
