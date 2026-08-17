// src/loader.js
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export function createGltfLoader(THREE_NS) {
  // 将来、DRACOとかKTX2対応するときはこの辺で拡張
  const loader = new GLTFLoader();
  return loader;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) return deepClone(override);
  const out = deepClone(base);
  if (!isPlainObject(override)) return out;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = deepClone(value);
    }
  }
  return out;
}

function isCompactSceneConfig(cfg) {
  return !!cfg && typeof cfg === "object" && !!cfg.droneTypesPath && Array.isArray(cfg.drones);
}

function normalizeProfileCatalog(cfg) {
  const raw = cfg?.droneProfiles;
  if (!raw) return [];
  if (!isPlainObject(raw)) {
    throw new Error("Scene config droneProfiles must be an object.");
  }
  return Object.entries(raw).map(([id, profile]) => {
    if (!isPlainObject(profile) || !profile.droneTypesPath || !profile.droneType) {
      throw new Error(`Invalid drone profile '${id}': droneTypesPath and droneType are required.`);
    }
    return {
      id,
      label: profile.label ?? id,
      droneTypesPath: profile.droneTypesPath,
      droneType: profile.droneType,
      optionalAssets: profile.optionalAssets === true,
      note: profile.note ?? "",
    };
  });
}

function applyDroneProfile(cfg, requestedProfileId) {
  const catalog = normalizeProfileCatalog(cfg);
  if (catalog.length === 0) {
    if (requestedProfileId) {
      throw new Error(`Scene config does not define droneProfiles; cannot select '${requestedProfileId}'.`);
    }
    return cfg;
  }
  const profileId = requestedProfileId ?? cfg.defaultDroneProfile ?? catalog[0].id;
  const profile = catalog.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`Unknown drone profile '${profileId}'. Available: ${catalog.map((item) => item.id).join(", ")}`);
  }
  cfg.droneTypesPath = profile.droneTypesPath;
  cfg.drones = (cfg.drones ?? []).map((drone) => ({ ...drone, type: profile.droneType }));
  cfg.resolvedDroneProfile = {
    id: profile.id,
    label: profile.label,
    optionalAssets: profile.optionalAssets,
    note: profile.note,
  };
  return cfg;
}

function resolveUrlFromBase(pathValue, baseUrl) {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return pathValue;
  }
  return new URL(pathValue, baseUrl).toString();
}

function normalizeEnvironmentModelPaths(cfg, sceneConfigUrl) {
  if (!Array.isArray(cfg.environments)) {
    return;
  }
  for (const env of cfg.environments) {
    if (env && typeof env.model === "string") {
      env.model = resolveUrlFromBase(env.model, sceneConfigUrl);
    }
    if (env && typeof env.terrainGridPath === "string") {
      env.terrainGridPath = resolveUrlFromBase(env.terrainGridPath, sceneConfigUrl);
    }
    if (env && typeof env.lod1Path === "string") {
      env.lod1Path = resolveUrlFromBase(env.lod1Path, sceneConfigUrl);
    }
    if (env && Array.isArray(env.sources)) {
      for (const source of env.sources) {
        if (source && typeof source.url === "string") {
          source.url = resolveUrlFromBase(source.url, sceneConfigUrl);
        }
      }
    }
  }
}

function normalizeDroneModelPaths(droneCfg, droneTypesUrl) {
  if (!droneCfg || typeof droneCfg !== "object") {
    return;
  }
  if (droneCfg.model?.model_path) {
    droneCfg.model.model_path = resolveUrlFromBase(droneCfg.model.model_path, droneTypesUrl);
  }
  if (Array.isArray(droneCfg.attachments)) {
    for (const attachment of droneCfg.attachments) {
      if (attachment?.model?.model_path) {
        attachment.model.model_path = resolveUrlFromBase(
          attachment.model.model_path,
          droneTypesUrl
        );
      }
    }
  }
  if (Array.isArray(droneCfg.rotors)) {
    for (const rotor of droneCfg.rotors) {
      if (rotor?.model?.model_path) {
        rotor.model.model_path = resolveUrlFromBase(rotor.model.model_path, droneTypesUrl);
      }
    }
  }
  if (Array.isArray(droneCfg.cameras)) {
    for (const camera of droneCfg.cameras) {
      if (camera?.model?.model_path) {
        camera.model.model_path = resolveUrlFromBase(camera.model.model_path, droneTypesUrl);
      }
    }
  }
}

async function loadDroneTypesFromPath(droneTypesPath, baseUrl) {
  const resolved = new URL(droneTypesPath, baseUrl).toString();
  const res = await fetch(resolved);
  if (!res.ok) {
    throw new Error(`Failed to load droneTypes: ${resolved}`);
  }
  return {
    droneTypes: await res.json(),
    droneTypesUrl: resolved,
  };
}

async function normalizeCompactSceneConfig(cfg, baseUrl, options = {}) {
  const normalized = applyDroneProfile(deepClone(cfg), options.droneProfileId);
  normalizeEnvironmentModelPaths(normalized, baseUrl);
  const { droneTypes, droneTypesUrl } = await loadDroneTypesFromPath(normalized.droneTypesPath, baseUrl);

  normalized.drones = (normalized.drones || []).map((instance) => {
    const typeId = instance.type ?? instance.droneType;
    if (!typeId || !droneTypes[typeId]) {
      throw new Error(`Invalid compact scene config: unknown drone type '${typeId}'.`);
    }
    const typeDef = deepClone(droneTypes[typeId]);
    const expanded = deepMerge(typeDef, instance);
    delete expanded.type;
    delete expanded.droneType;
    expanded.resolvedType = typeId;
    normalizeDroneModelPaths(expanded, droneTypesUrl);
    return expanded;
  });

  return normalized;
}

async function normalizeSceneConfig(cfg, baseUrl, options = {}) {
  if (!isCompactSceneConfig(cfg)) {
    throw new Error("Scene config must be compact format (droneTypesPath + drones).");
  }
  return await normalizeCompactSceneConfig(cfg, baseUrl, options);
}
// src/config_loader.js
export async function loadSceneProfileCatalog(url = "/config/drone_config-compact-1.json") {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load config: ${url}`);
  }
  const cfg = await res.json();
  const profiles = normalizeProfileCatalog(cfg);
  return {
    defaultProfileId: cfg.defaultDroneProfile ?? profiles[0]?.id ?? null,
    profiles: profiles.map(({ id, label, optionalAssets, note }) => ({
      id,
      label,
      optionalAssets,
      note,
    })),
  };
}

export async function loadConfig(url = "/config/drone_config-compact-1.json", options = {}) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load config: ${url}`);
  }
  const json = await res.json();
  const normalized = await normalizeSceneConfig(json, new URL(url, window.location.href), options);
  console.log("[Hakoniwa] config loaded:", normalized);
  return normalized;
}
