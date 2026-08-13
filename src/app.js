// src/app.js
import * as THREE from 'three';
import { HakoniwaFrame } from "./frame.js";
import { createGltfLoader, loadConfig } from "./loader.js?v=phase-e-20260813-1";
import { OrbitCamera } from "./orbit_camera.js";
import { buildEnvironments, selectEnvironmentConfigs } from './environment.js?v=phase-e-20260813-10';
import { Drone } from "./drone.js?v=phase-e-20260813-13";

console.log("[Hakoniwa] app.js loaded");

const clock = new THREE.Clock();

const container = document.getElementById("three-root");
if (!container) {
  console.error("[Hakoniwa] three-root element not found");
  // 念のため fallback（デバッグ用）
  // throw new Error("three-root not found"); でも OK
}
const loader = createGltfLoader(THREE);

let orbitCam = null;
let drones = [];
let environments = [];
let environmentScopeProfiles = {};
let currentEnvironmentScope = null;
let selectedOperationalDroneId = null;
const environmentDiagnostics = new Map();
let beforeDronesUpdateHook = null;
const runtimeOptions = {
  enableAttachedCameras: true,
  enableMainCameraMouseControl: true,
};
const keyState = {};              // キーボード状態

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function buildDroneName(baseName, index1Based) {
  if (typeof baseName !== "string" || baseName.length === 0) {
    return `Drone-${index1Based}`;
  }
  const m = baseName.match(/^(.*?)(?:[-_ ]?)(\d+)$/);
  if (m && m[1]) {
    const prefix = m[1].replace(/[-_ ]+$/, "");
    return `${prefix}-${index1Based}`;
  }
  return `${baseName}-${index1Based}`;
}

function expandDroneInstances(sceneDrones, {
  dynamicSpawn = false,
  templateDroneIndex = 0,
  maxDynamicDrones = 1,
} = {}) {
  const src = Array.isArray(sceneDrones) ? sceneDrones : [];
  if (!dynamicSpawn) {
    return src;
  }
  if (src.length === 0) {
    throw new Error("[Hakoniwa] dynamicSpawn requires at least one drone in scene config.");
  }
  if (!Number.isInteger(templateDroneIndex) || templateDroneIndex < 0 || templateDroneIndex >= src.length) {
    throw new Error(`[Hakoniwa] invalid templateDroneIndex: ${templateDroneIndex}`);
  }
  if (!Number.isInteger(maxDynamicDrones) || maxDynamicDrones <= 0) {
    throw new Error(`[Hakoniwa] invalid maxDynamicDrones: ${maxDynamicDrones}`);
  }
  const template = src[templateDroneIndex];
  const templateName = template?.name ?? "Drone";
  const out = [];
  for (let i = 0; i < maxDynamicDrones; i++) {
    const d = deepClone(template);
    d.name = buildDroneName(templateName, i + 1);
    out.push(d);
  }
  return out;
}

export function getDrones() {
  return drones;
}
export function getEnvironmentDiagnostics() {
  const diagnostics = new Map(environmentDiagnostics);
  for (const environment of environments) {
    if (environment?.environmentDiagnostics) {
      diagnostics.set(environment.environmentDiagnostics.name, environment.environmentDiagnostics);
    }
  }
  return Array.from(diagnostics.values()).map((item) => deepClone(item));
}
export function setBeforeDronesUpdateHook(hookFn) {
  beforeDronesUpdateHook = typeof hookFn === "function" ? hookFn : null;
}
export function setViewerRuntimeOptions(options = {}) {
  if (typeof options.enableAttachedCameras === "boolean") {
    runtimeOptions.enableAttachedCameras = options.enableAttachedCameras;
  }
  if (typeof options.enableMainCameraMouseControl === "boolean") {
    runtimeOptions.enableMainCameraMouseControl = options.enableMainCameraMouseControl;
  }
  if (orbitCam) {
    orbitCam.setMouseControlEnabled(runtimeOptions.enableMainCameraMouseControl);
  }
}
// renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c9df);
scene.fog = new THREE.Fog(0xc6d8e4, 700, 2200);

// light
const hemi = new THREE.HemisphereLight(0xeaf7ff, 0x6f756a, 1.45);
hemi.position.set(0, 300, 0);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xfff3d6, 2.2);
dir.position.set(-260, 480, 180);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.left = -380;
dir.shadow.camera.right = 380;
dir.shadow.camera.top = 380;
dir.shadow.camera.bottom = -380;
dir.shadow.camera.near = 10;
dir.shadow.camera.far = 1100;
dir.shadow.bias = -0.00015;
scene.add(dir);

const ambient = new THREE.AmbientLight(0xc9d7df, 0.38);
scene.add(ambient);

// カメラ初期位置計算用
const tmpVec3 = new THREE.Vector3();

// -------------------------------------------------------------
//  main
// -------------------------------------------------------------
export async function main(
  url = "/config/drone_config-compact-1.json",
  {
    dynamicSpawn = false,
    templateDroneIndex = 0,
    maxDynamicDrones = 1,
    environmentMode = null,
    droneProfileId = null,
  } = {},
) {
  console.log("[Hakoniwa] main() start. loading config:", url);
  const cfg = await loadConfig(url, { droneProfileId });
  environmentScopeProfiles = cfg.environmentScopes ?? {};

  // Environment
  if (cfg.environments) {
    environmentDiagnostics.clear();
    const selectedEnvironmentMode = environmentMode ?? cfg.environmentMode ?? "physics";
    const selectedEnvironments = selectEnvironmentConfigs(cfg.environments, selectedEnvironmentMode);
    environments = await buildEnvironments(scene, loader, selectedEnvironments, {
      onStatus: (diagnostics) => {
        environmentDiagnostics.set(diagnostics.name, deepClone(diagnostics));
        console.log("[Hakoniwa] environment status:", diagnostics);
      },
    });
    if (selectedEnvironmentMode === "visual") {
      console.log("[Hakoniwa] visual environment selected");
    }
  }

  // Drones
  const rawSceneDrones = expandDroneInstances(cfg.drones, {
    dynamicSpawn,
    templateDroneIndex,
    maxDynamicDrones,
  });

  drones = [];
  for (const dcfg of rawSceneDrones) {
    const drone = await Drone.create(scene, loader, dcfg, {
      motorChannels: cfg.motorChannels ?? [0, 1, 2, 3],
      rotorScale: cfg.rotorScale ?? 200.0,
      pduPollIntervalMs: cfg.pduPollIntervalMs ?? 100,
    });
    drones.push(drone);
  }
  setOperationalSelectedDroneId(drones[0]?.droneId ?? null);

  // Camera
  const mc = cfg.mainCamera || cfg.main_camera || {};
  const cameraPositionRos = mc.position ?? mc.pos;
  const cameraTargetRos = mc.targetPositionRos ?? (Array.isArray(mc.target) ? mc.target : null);
  if (Array.isArray(cameraPositionRos) && Array.isArray(cameraTargetRos)) {
    const targetWorld = HakoniwaFrame.rosPosToThree(cameraTargetRos);
    const camPos = HakoniwaFrame.rosPosToThree(cameraPositionRos);
    const followTarget = typeof mc.target === "string"
      ? drones.find((drone) => String(drone.droneId) === String(mc.target)) ?? null
      : null;

    orbitCam = new OrbitCamera(renderer, {
      fov:  mc.fov  ?? 60,
      near: mc.near ?? 0.1,
      far:  mc.far  ?? 1000,
      position: [camPos.x,      camPos.y,      camPos.z],
      target:   [targetWorld.x, targetWorld.y, targetWorld.z],

      followTarget,
      initialMode: mc.initialMode ?? "fixed",
      followDistance: mc.followDistance ?? null,
      followLerpPos: mc.followLerpPos ?? 8.0,
      followLerpTarget: mc.followLerpTarget ?? 10.0,
      followToggleKey: mc.followToggleKey ?? "c",
      mouseEnabled: runtimeOptions.enableMainCameraMouseControl,
    });

  } else {
    orbitCam = new OrbitCamera(renderer, {
      mouseEnabled: runtimeOptions.enableMainCameraMouseControl,
    });
  }

  scene.add(orbitCam.entity.object3d);
  for (const environment of environments) {
    environment.bindViewer?.(orbitCam.camera, renderer);
  }
  setEnvironmentScope(cfg.initialEnvironmentScope ?? "local");
  animate();
  return {
    environmentMode: environmentMode ?? cfg.environmentMode ?? "physics",
    droneProfile: cfg.resolvedDroneProfile ?? null,
  };
}

export function focusDroneById(droneId, { snap = true } = {}) {
  if (!orbitCam || !drones?.length) return false;

  const target = drones.find(d => String(d.droneId) === String(droneId));
  if (!target) return false;

  setOperationalSelectedDroneId(target.droneId);
  orbitCam.setFollowTarget(target);
  orbitCam.setMode("follow");

  return true;
}

export function setOperationalSelectedDroneId(droneId) {
  selectedOperationalDroneId = droneId == null ? null : String(droneId);
  for (const drone of drones) {
    drone.setOperationalSelected?.(
      selectedOperationalDroneId !== null
      && String(drone.droneId) === selectedOperationalDroneId
    );
  }
  return selectedOperationalDroneId;
}

export function setCameraPoseRos({
  position,
  targetPositionRos,
  target,
  far = null,
  minPolarAngleDeg = null,
  maxPolarAngleDeg = null,
  minDistanceM = null,
  enablePan = null,
} = {}) {
  if (!orbitCam || !Array.isArray(position)) return false;
  const resolvedTarget = targetPositionRos ?? target;
  if (!Array.isArray(resolvedTarget)) return false;
  const cameraWorld = HakoniwaFrame.rosPosToThree(position);
  const targetWorld = HakoniwaFrame.rosPosToThree(resolvedTarget);
  orbitCam.setPose({
    position: [cameraWorld.x, cameraWorld.y, cameraWorld.z],
    target: [targetWorld.x, targetWorld.y, targetWorld.z],
    far,
    minPolarAngleDeg,
    maxPolarAngleDeg,
    minDistanceM,
    enablePan,
  });
  return true;
}

export function setEnvironmentScope(scope, { applyCamera = true } = {}) {
  const normalized = String(scope || "local");
  currentEnvironmentScope = normalized;
  for (const environment of environments) {
    const scopes = environment.environmentScopes ?? [];
    environment.object3d.visible = scopes.length === 0 || scopes.includes(normalized);
  }
  for (const drone of drones) drone.setOperationalScope?.(normalized);
  const profile = environmentScopeProfiles?.[normalized] ?? {};
  if (scene.fog && profile.fog) {
    if (Number.isFinite(Number(profile.fog.near))) scene.fog.near = Number(profile.fog.near);
    if (Number.isFinite(Number(profile.fog.far))) scene.fog.far = Number(profile.fog.far);
  }
  if (applyCamera && profile.camera) setCameraPoseRos(profile.camera);
  return { scope: normalized };
}

export function getEnvironmentScope() {
  return currentEnvironmentScope;
}

export function getFocusedDroneId() {
  return orbitCam?.followTarget?.droneId == null
    ? null
    : String(orbitCam.followTarget.droneId);
}

export function setCameraFollowEnabled(enabled) {
  if (!orbitCam) return false;
  orbitCam.setMode(enabled ? "follow" : "fixed");
  return true;
}

export function resizeViewer() {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  renderer.setSize(width, height);
  if (orbitCam) orbitCam.resize(width, height);
  for (const environment of environments) {
    environment.resizeViewer?.(orbitCam?.camera, renderer);
  }
  return {
    width,
    height,
    aspect: width / height,
    cameraAspect: orbitCam?.camera?.aspect ?? null,
  };
}

// -------------------------------------------------------------
//  loop
// -------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);

  let dt = clock.getDelta();
  if (dt < 0.0001) dt = 0.0001; // ほぼ0は 0.1ms とみなす
  if (dt > 0.05)   dt = 0.05;   // 50ms(=20fps) より大きいのは固定

  if (beforeDronesUpdateHook) {
    beforeDronesUpdateHook(dt);
  }

  for (let i = 0; i < drones.length; i++) {
    drones[i].update(dt, keyState);
  }
  if (keyState["1"]) {
    orbitCam.updateFollowDistance(-dt * 1.0);
  }
  if (keyState["2"]) {
    orbitCam.updateFollowDistance(dt * 1.0);
  }

  if (orbitCam) {
    orbitCam.update(dt);
    orbitCam.camera.updateMatrixWorld(true);
    for (const environment of environments) {
      if (environment.object3d.visible) environment.updateEnvironment?.(dt);
    }

    const w = container.clientWidth;
    const h = container.clientHeight;

    // ① メインビュー
    renderer.setViewport(0, 0, w, h);
    renderer.setScissorTest(false);
    renderer.render(scene, orbitCam.camera);

    // ② 小窓カメラ（選択されているドローンのフロントカメラのみをレンダリング）
    if (runtimeOptions.enableAttachedCameras && drones.length > 0) {
      const selectedDrone = selectedOperationalDroneId == null
        ? null
        : drones.find((drone) => String(drone.droneId) === selectedOperationalDroneId);
      const activeDrone = selectedDrone || orbitCam.followTarget || drones[0];
      if (activeDrone && typeof activeDrone.renderAttachedCameras === 'function') {
        activeDrone.renderAttachedCameras(renderer, scene, w, h);
      }
    }
  }
}

// -------------------------------------------------------------
//  events
// -------------------------------------------------------------
window.addEventListener("resize", () => {
  resizeViewer();
});

window.addEventListener("keydown", (e) => {
  keyState[e.key] = true;
});

window.addEventListener("keyup", (e) => {
  keyState[e.key] = false;
});
