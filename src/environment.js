// src/environment.js
import * as THREE from "three";
import { RenderEntity } from "./render_entity.js";
import { createInstancedBuildingEnvironmentFromMjcfXml } from "./mjcf_building.js?v=r3-20260809-2";
import { buildTerrainGridEnvironment } from "./terrain_environment.js?v=r2-20260809-6";
import { buildLod1CityEnvironment } from "./lod1_city_environment.js?v=phase-e-20260812-1";
import { buildPlateau3DTilesEnvironment } from "./plateau_3dtiles_environment.js?v=phase-e-20260813-10";

/**
 * 単一 Environment を構築する
 * - Python の EnvironmentEntity 相当
 * @param {THREE.Scene} scene
 * @param {THREE.Loader} loader GLTFLoader を想定（非 XML のときに使用）
 * @param {Object} envCfg  config.environments[i]
 *   - name: string
 *   - model: string (GLB/GLTF/MJCF の URL)
 *   - pos: [x, y, z] （ROS 座標系）
 *   - hpr: [r, p, y] （deg, ROS）
 *   - scale: number
 * @returns {Promise<RenderEntity>}
 */
export async function buildEnvironment(scene, loader, envCfg) {
  const ent = new RenderEntity(envCfg.name);
  const environmentType = envCfg.type ?? "model";
  const modelPath = envCfg.model ?? "";
  const lower = modelPath.toLowerCase();

  const isXml = envCfg.kind === "mjcf" || lower.endsWith(".xml");

  // ---------- モデルロード部分 ----------
  if (environmentType === "terrain-grid") {
    console.log(`Loading terrain-grid environment: ${envCfg.terrainGridPath}`);
    const terrain = await buildTerrainGridEnvironment(envCfg);
    ent.setAttachment(terrain.object3d);
    ent.environmentDiagnostics = terrain.diagnostics;
  } else if (environmentType === "lod1-city") {
    console.log(`Loading PLATEAU LOD1 city environment: ${envCfg.lod1Path}`);
    const city = await buildLod1CityEnvironment(envCfg);
    ent.setAttachment(city.object3d);
    ent.environmentDiagnostics = city.diagnostics;
  } else if (environmentType === "plateau-3dtiles") {
    console.log(`Loading streamed PLATEAU LOD1 3D Tiles environment: ${envCfg.name}`);
    const city = await buildPlateau3DTilesEnvironment(envCfg);
    ent.setAttachment(city.object3d);
    ent.environmentDiagnostics = city.diagnostics;
    ent.bindViewer = city.bindViewer;
    ent.resizeViewer = city.resize;
    ent.updateEnvironment = city.update;
  } else if (isXml) {
    console.log(`Loading MJCF environment model: ${modelPath}`);
    // MJCF から建物群をロード
    const res = await fetch(modelPath);
    if (!res.ok) {
      throw new Error(`Failed to load MJCF xml: ${modelPath}`);
    }
    const xmlText = await res.text();

    // 親 = ent.object3d としてビル群をぶら下げる
    const buildingEnvironment = createInstancedBuildingEnvironmentFromMjcfXml(xmlText, {
      name: envCfg.name,
      material: envCfg.material,
    });
    ent.setAttachment(buildingEnvironment.object3d);
    ent.buildingEntities = buildingEnvironment.buildings;
    ent.environmentDiagnostics = {
      name: envCfg.name,
      type: "mjcf",
      status: "ready",
      source: modelPath,
      ...buildingEnvironment.diagnostics,
    };
  } else {
    if (!modelPath) {
      throw new Error(`[Environment] model is required for type '${environmentType}'`);
    }
    // 通常の 3D モデル（GLB/GLTF 等）
    const gltfRoot = await new Promise((resolve, reject) => {
      loader.load(
        modelPath,
        (gltf) => resolve(gltf.scene),
        undefined,
        reject
      );
    });

    // 表裏両面（屋内モデル対策）
    gltfRoot.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        // 複数マテリアル対応
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => {
            if (m && "side" in m) m.side = THREE.DoubleSide;
          });
        } else {
          obj.material.side = THREE.DoubleSide;
        }
      }
    });

    // RenderEntity にぶら下げる
    ent.setAttachment(gltfRoot);
    ent.environmentDiagnostics = {
      name: envCfg.name,
      type: "gltf",
      status: "ready",
      source: modelPath,
    };
  }

  // ---------- 姿勢・スケール ----------
  // Python: if scale is not None: self.np.setScale(scale)
  if (envCfg.scale != null) {
    ent.object3d.scale.set(envCfg.scale, envCfg.scale, envCfg.scale);
  }

  // Python: if pos is not None: self.set_pos(*pos)
  if (envCfg.pos) {
    ent.setPositionRos(envCfg.pos);
  }

  // Python: if hpr is not None:
  //   target_np = self.np if xml else self._geom_np
  // three.js 版では簡略化して「環境の root(ent.object3d)」に適用している。
  if (envCfg.hpr) {
    ent.setRpyRosDeg(envCfg.hpr);
  }

  // ---------- 大きすぎ / 小さすぎ補正 ----------
  // Python:
  // mn, mx = self.np.getTightBounds()
  // diag = (mx - mn).length()
  // if diag > 1e4: self.np.setScale(100.0 / diag)
  // elif diag < 1e-2: self.np.setScale(100.0 / max(diag, 1e-6))
  const bbox = new THREE.Box3().setFromObject(ent.object3d);
  if (!bbox.isEmpty()) {
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const diag = size.length();
    if (diag > 1e4) {
      const s = 100.0 / diag;
      ent.object3d.scale.multiplyScalar(s);
    } else if (diag < 1e-2) {
      const s = 100.0 / Math.max(diag, 1e-6);
      ent.object3d.scale.multiplyScalar(s);
    }
  }

  // シーンに追加
  ent.environmentScopes = Array.isArray(envCfg.scopes) ? [...envCfg.scopes] : [];
  scene.add(ent.object3d);
  return ent;
}

/**
 * 複数 Environment をまとめて構築するユーティリティ
 * @param {THREE.Scene} scene
 * @param {THREE.Loader} loader
 * @param {Array<Object>} envCfgs
 * @returns {Promise<RenderEntity[]>}
 */
export async function buildEnvironments(scene, loader, envCfgs = [], { onStatus } = {}) {
  const results = [];
  for (const cfg of envCfgs) {
    if (cfg?.enabled === false) continue;
    const loading = {
      name: cfg?.name ?? "environment",
      type: cfg?.type ?? "model",
      status: "loading",
    };
    onStatus?.(loading);
    try {
      const ent = await buildEnvironment(scene, loader, cfg);
      results.push(ent);
      onStatus?.(ent.environmentDiagnostics ?? { ...loading, status: "ready" });
    } catch (error) {
      onStatus?.({ ...loading, status: "error", error: error?.message ?? String(error) });
      if (cfg?.optional === true) {
        console.warn(`[Environment] optional environment '${loading.name}' was skipped:`, error);
        continue;
      }
      throw error;
    }
  }
  return results;
}

export function selectEnvironmentConfigs(envCfgs = [], mode = "physics") {
  if (mode === "none") return [];
  if (mode !== "physics" && mode !== "visual") {
    throw new Error(`[Environment] unsupported environment mode: ${mode}`);
  }
  return envCfgs.filter((cfg) => {
    if (cfg?.enabled === false) return false;
    const modes = Array.isArray(cfg?.modes) ? cfg.modes : ["physics", "visual"];
    return modes.includes(mode);
  });
}
