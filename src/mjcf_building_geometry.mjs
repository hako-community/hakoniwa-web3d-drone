export const MJCF_BUILDING_GEOMETRY_VERSION = 1;

function requireFiniteTriplet(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => !Number.isFinite(v))) {
    throw new Error(`[MJCF building] ${label} must be a finite 3-vector.`);
  }
  return value;
}

/**
 * Convert a MuJoCo building box to Three.js coordinates.
 *
 * MuJoCo/Hakoniwa: x=North, y=-East, z=Up
 * Three.js:         x=Right, y=Up,    z=Back
 * Position contract: [x, y, z] -> [-y, z, -x]
 */
export function mujocoBuildingToThreeTransform({ size, pos, rxyzDeg }) {
  const [sizeX, sizeY, sizeZ] = requireFiniteTriplet(size, "size");
  const [x, y, z] = requireFiniteTriplet(pos, "pos");
  const [, , yawDeg] = requireFiniteTriplet(rxyzDeg, "rxyzDeg");
  if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) {
    throw new Error("[MJCF building] size values must be greater than zero.");
  }
  return {
    position: [-y, z, -x],
    // Unit BoxGeometry axes: Three X <- MuJoCo Y, Three Y <- Z, Three Z <- X.
    scale: [sizeY, sizeZ, sizeX],
    yawRad: yawDeg * Math.PI / 180,
  };
}

export function summarizeBuildingData(buildings = []) {
  if (!Array.isArray(buildings) || buildings.length === 0) {
    return {
      buildingCount: 0,
      minimumBaseHeightM: null,
      maximumTopHeightM: null,
      boundsMujoco: null,
    };
  }

  let minimumBaseHeightM = Infinity;
  let maximumTopHeightM = -Infinity;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const building of buildings) {
    const [sx, sy, sz] = requireFiniteTriplet(building.size, "size");
    const [x, y, z] = requireFiniteTriplet(building.pos, "pos");
    const half = [sx / 2, sy / 2, sz / 2];
    minimumBaseHeightM = Math.min(minimumBaseHeightM, z - half[2]);
    maximumTopHeightM = Math.max(maximumTopHeightM, z + half[2]);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], building.pos[axis] - half[axis]);
      max[axis] = Math.max(max[axis], building.pos[axis] + half[axis]);
    }
  }
  return {
    buildingCount: buildings.length,
    minimumBaseHeightM,
    maximumTopHeightM,
    boundsMujoco: { min, max },
  };
}
