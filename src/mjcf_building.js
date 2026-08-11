// mjcf_building.js
import * as THREE from "three";
import { RenderEntity } from "./render_entity.js";
import {
  MJCF_BUILDING_GEOMETRY_VERSION,
  mujocoBuildingToThreeTransform,
  summarizeBuildingData,
} from "./mjcf_building_geometry.mjs?v=r3-20260809-2";

export { MJCF_BUILDING_GEOMETRY_VERSION };

/**
 * Python側の BuildingData 相当のクラス
 * - size: [sx, sy, sz]  (three.js 空間でのサイズ)
 * - pos:  [x, y, z]
 * - hprDeg: [h, p, r] （degree）
 * - color: [r, g, b, a]
 */
export class BuildingData {
  constructor(name, size, pos, rxyzDeg, color) {
    this.name = name;
    this.size = size;
    this.pos = pos;
    this.rxyzDeg = rxyzDeg;
    this.color = color;
  }
}

// "1 2 3" → [1, 2, 3]
function parseVector(str) {
  return str
    .trim()
    .split(/\s+/)
    .map((v) => Number(v));
}

/**
 * MJCF(XML文字列)を解析し、BuildingData の配列を返す。
 * Python版 load_buildings_from_mjcf とほぼ同じロジック。
 *
 * @param {string} xmlText - MJCFファイルの中身（文字列）
 * @returns {BuildingData[]}
 */
export function loadBuildingsFromMjcfXml(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "application/xml");

  const geoms = xmlDoc.querySelectorAll("geom");
  const buildings = [];

  geoms.forEach((geom) => {
    const name = geom.getAttribute("name");
    if (!name || !name.startsWith("geom_bldg_")) {
      return;
    }

    const sizeStr = geom.getAttribute("size");
    const posStr = geom.getAttribute("pos");
    const eulerStr = geom.getAttribute("euler");
    const rgbaStr = geom.getAttribute("rgba");

    if (!sizeStr || !posStr || !eulerStr) {
      return;
    }

    const sizeMj = parseVector(sizeStr);
    const posMj = parseVector(posStr);
    const eulerMj = parseVector(eulerStr);
    const rgbaMj = rgbaStr ? parseVector(rgbaStr) : [0.25, 0.65, 1.0, 0.35];

    // --- サイズ変換 ---
    const size = [
      sizeMj[0] * 2,
      sizeMj[1] * 2,
      sizeMj[2] * 2,
    ];

    // --- 位置変換 ---
    const pos = [posMj[0], posMj[1], posMj[2]];

    // --- 回転変換 ---
    const rxyzDeg = [eulerMj[0], eulerMj[1], eulerMj[2]];

    const color = rgbaMj.length === 4 ? rgbaMj : [0.25, 0.65, 1.0, 0.35];

    buildings.push(new BuildingData(name, size, pos, rxyzDeg, color));
  });

  return buildings;
}

/**
 * BuildingData の配列から RenderEntity を生成し、
 * three.js の scene に追加して返す。
 *
 * @param {THREE.Scene} scene
 * @param {BuildingData[]} buildingDataList
 * @param {object} [options]
 *   - materialFactory?: (data: BuildingData, baseColor: THREE.Color) => THREE.Material
 * @returns {RenderEntity[]}
 */
export function createBuildingEntities(scene, buildingDataList, options = {}) {
  const { materialFactory } = options;
  const entities = [];

  for (const data of buildingDataList) {
    //all data is mujoco frame
    const [sx, sy, sz] = data.size;
    const [x, y, z] = data.pos;
    const [pDeg, rDeg, hDeg] = data.rxyzDeg;
    const [r, g, b] = data.color;

    const geometry = new THREE.BoxGeometry(sy, sz, sx);
    const baseColor = new THREE.Color(r, g, b);

    const material =
      typeof materialFactory === "function"
        ? materialFactory(data, baseColor)
        : new THREE.MeshStandardMaterial({ color: baseColor });

    const mesh = new THREE.Mesh(geometry, material);

    const entity = new RenderEntity(data.name);
    entity.setAttachment(mesh);

    // 位置・姿勢設定
    //console.log("pos:", x, y, z);
    entity.setPositionRos([x, y, z]);
    //console.log("hprDeg:", hDeg, pDeg, rDeg);
    entity.setRpyRosDeg([rDeg, pDeg, hDeg]);

    // シーンに追加
    entity.attachToScene(scene);
    entities.push(entity);
  }

  return entities;
}

/**
 * Render thousands of collision boxes with one draw call.
 * Individual boxes remain available through createBuildingEntities for legacy users.
 */
export function createInstancedBuildingEnvironmentFromMjcfXml(xmlText, options = {}) {
  const buildings = loadBuildingsFromMjcfXml(xmlText);
  const materialOptions = options.material ?? {};
  const opacity = Number.isFinite(materialOptions.opacity)
    ? Math.max(0.0, Math.min(1.0, materialOptions.opacity))
    : 0.38;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(materialOptions.color ?? "#4b9bd6"),
    transparent: opacity < 1.0,
    opacity,
    depthWrite: materialOptions.depthWrite ?? opacity >= 1.0,
    roughness: materialOptions.roughness ?? 0.82,
    metalness: materialOptions.metalness ?? 0.0,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, buildings.length);
  mesh.name = options.name ?? "mjcf-collision-buildings";

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  buildings.forEach((building, index) => {
    const transform = mujocoBuildingToThreeTransform(building);
    position.fromArray(transform.position);
    quaternion.setFromAxisAngle(up, transform.yawRad);
    scale.fromArray(transform.scale);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();

  const diagnostics = {
    ...summarizeBuildingData(buildings),
    geometryVersion: MJCF_BUILDING_GEOMETRY_VERSION,
    renderStrategy: "instanced-mesh",
    drawCallCount: buildings.length > 0 ? 1 : 0,
    coordinateFrame: "mujoco_x_north_y_minus_east_z_up",
    threePositionMapping: "[-y, z, -x]",
    material: {
      mode: materialOptions.mode ?? "collision-debug",
      color: `#${material.color.getHexString()}`,
      opacity,
    },
  };
  return { object3d: mesh, buildings, diagnostics };
}

/**
 * 便利関数:
 *   - MJCF文字列をパースして
 *   - そのまま建物 RenderEntity を作って scene に貼る
 */
export function createBuildingEntitiesFromMjcfXml(scene, xmlText, options = {}) {
  const result = createInstancedBuildingEnvironmentFromMjcfXml(xmlText, options);
  if (scene && typeof scene.add === "function") {
    scene.add(result.object3d);
  }
  return result.buildings;
}
