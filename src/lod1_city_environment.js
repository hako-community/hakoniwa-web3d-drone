import * as THREE from "three";

export const LOD1_CITY_ENVIRONMENT_VERSION = 1;

const DEFAULT_WALL_PALETTE = Object.freeze([
  "#d9d2c3",
  "#c8d3d8",
  "#d9c4b2",
  "#c9c7bf",
  "#d8d8d2",
]);

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value ?? "building")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseVertex(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value ?? "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  const east = finiteNumber(parts[0]);
  const north = finiteNumber(parts[1]);
  return east == null || north == null ? null : new THREE.Vector2(east, -north);
}

function normalizedContour(rawVertices) {
  const points = (Array.isArray(rawVertices) ? rawVertices : [])
    .map(parseVertex)
    .filter(Boolean);
  if (points.length >= 2 && points[0].distanceToSquared(points.at(-1)) < 1e-10) {
    points.pop();
  }
  return points;
}

function pushColor(target, color, count = 1) {
  for (let index = 0; index < count; index += 1) {
    target.push(color.r, color.g, color.b);
  }
}

function upwardRoofTriangle(points, triangle) {
  const [a, b, c] = triangle;
  const pa = points[a];
  const pb = points[b];
  const pc = points[c];
  const crossY = (pb.y - pa.y) * (pc.x - pa.x) - (pb.x - pa.x) * (pc.y - pa.y);
  return crossY >= 0 ? [a, b, c] : [a, c, b];
}

export async function buildLod1CityEnvironment(envCfg = {}) {
  const source = envCfg.lod1Path;
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("[Lod1City] lod1Path is required");
  }
  const response = await fetch(source, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`[Lod1City] failed to load ${source}: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data?.version !== "1.0" || !Array.isArray(data?.polygons)) {
    throw new Error("[Lod1City] unsupported source schema");
  }

  const materialConfig = envCfg.material ?? {};
  const zBaselineM = finiteNumber(envCfg.zBaselineM, 0);
  const wallPalette = (Array.isArray(materialConfig.wallPalette)
    ? materialConfig.wallPalette
    : DEFAULT_WALL_PALETTE).map((value) => new THREE.Color(value));
  const roofBase = new THREE.Color(materialConfig.roofColor ?? "#747d80");
  const positions = [];
  const colors = [];
  const indices = [];
  let buildingCount = 0;
  let skippedCount = 0;
  let triangleCount = 0;
  let minimumBaseHeightM = Infinity;
  let maximumTopHeightM = -Infinity;

  for (const polygon of data.polygons) {
    const points = normalizedContour(polygon?.vertices);
    const sourceZMin = finiteNumber(polygon?.zmin);
    const sourceZMax = finiteNumber(polygon?.zmax);
    const zMin = sourceZMin == null ? null : sourceZMin - zBaselineM;
    const zMax = sourceZMax == null ? null : sourceZMax - zBaselineM;
    if (points.length < 3 || zMin == null || zMax == null || zMax - zMin < 0.3) {
      skippedCount += 1;
      continue;
    }
    const roofTriangles = THREE.ShapeUtils.triangulateShape(points, []);
    if (roofTriangles.length === 0) {
      skippedCount += 1;
      continue;
    }

    const hash = stableHash(polygon.id);
    const wallColor = wallPalette[hash % wallPalette.length].clone();
    const heightFactor = Math.max(0, Math.min(1, (zMax - zMin) / 90));
    wallColor.offsetHSL(0, 0, (heightFactor - 0.35) * 0.08);
    const roofColor = roofBase.clone().offsetHSL(
      ((hash >>> 8) % 7 - 3) * 0.004,
      0,
      ((hash >>> 16) % 9 - 4) * 0.008,
    );

    const roofOffset = positions.length / 3;
    for (const point of points) {
      positions.push(point.x, zMax, point.y);
      pushColor(colors, roofColor);
    }
    for (const triangle of roofTriangles) {
      const [a, b, c] = upwardRoofTriangle(points, triangle);
      indices.push(roofOffset + a, roofOffset + b, roofOffset + c);
      triangleCount += 1;
    }

    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const wallOffset = positions.length / 3;
      positions.push(
        a.x, zMin, a.y,
        b.x, zMin, b.y,
        b.x, zMax, b.y,
        a.x, zMax, a.y,
      );
      pushColor(colors, wallColor, 4);
      indices.push(
        wallOffset, wallOffset + 1, wallOffset + 2,
        wallOffset, wallOffset + 2, wallOffset + 3,
      );
      triangleCount += 2;
    }

    buildingCount += 1;
    minimumBaseHeightM = Math.min(minimumBaseHeightM, zMin);
    maximumTopHeightM = Math.max(maximumTopHeightM, zMax);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: Number(materialConfig.roughness ?? 0.78),
    metalness: Number(materialConfig.metalness ?? 0.02),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = envCfg.name ?? "plateau-lod1-city";
  mesh.castShadow = materialConfig.castShadow !== false;
  mesh.receiveShadow = true;
  mesh.userData.lod1CityDiagnostics = {
    name: mesh.name,
    type: "lod1-city",
    status: "ready",
    source,
    buildingCount,
    skippedCount,
    triangleCount,
    vertexCount: positions.length / 3,
    minimumBaseHeightM: Number.isFinite(minimumBaseHeightM) ? minimumBaseHeightM : null,
    maximumTopHeightM: Number.isFinite(maximumTopHeightM) ? maximumTopHeightM : null,
    zBaselineM,
    boundsMeters: data.bounds ?? null,
    coordinateFrame: "relative-enu_to_three_x_up_minus_north",
  };
  return { object3d: mesh, diagnostics: mesh.userData.lod1CityDiagnostics };
}
