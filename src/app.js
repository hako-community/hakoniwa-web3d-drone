// src/app.js
import * as THREE from 'three';
import { HakoniwaFrame } from "./frame.js";
import { createGltfLoader, loadConfig } from "./loader.js";
import { OrbitCamera } from "./orbit_camera.js";
import { buildEnvironments, selectEnvironmentConfigs } from './environment.js?v=r3-20260809-2';
import { Drone } from "./drone.js";

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
  return Array.from(environmentDiagnostics.values()).map((item) => deepClone(item));
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
renderer.toneMappingExposure = 1.25;
container.appendChild(renderer.domElement);

// scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf1f4f8);

// light
const hemi = new THREE.HemisphereLight(0xffffff, 0xa0a0a0, 1.15);
hemi.position.set(0, 20, 0);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.5);
dir.position.set(5, 10, 5);
scene.add(dir);

const ambient = new THREE.AmbientLight(0xffffff, 0.55);
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

  // Camera
  const mc = cfg.mainCamera || {};
  if (mc.pos && mc.target) {
    const targetWorld = HakoniwaFrame.rosToThreePosition(mc.target);
    const offsetRos = [
      mc.pos[0] - mc.target[0],
      mc.pos[1] - mc.target[1],
      mc.pos[2] - mc.target[2],
    ];

    const R = HakoniwaFrame.rosHprToThreeQuaternion(mc.hpr ?? [0, 0, 0]);
    const offsetThree = HakoniwaFrame.rosToThreePosition(offsetRos).applyQuaternion(R);

    const camPos = targetWorld.clone().add(offsetThree);
    const followTarget = (drones.length > 0) ? drones[0] : null;

    orbitCam = new OrbitCamera(renderer, {
      fov:  mc.fov  ?? 60,
      near: mc.near ?? 0.1,
      far:  mc.far  ?? 1000,
      position: [camPos.x,      camPos.y,      camPos.z],
      target:   [targetWorld.x, targetWorld.y, targetWorld.z],

      followTarget,
      initialMode: mc.initialMode ?? "follow",
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

  orbitCam.setFollowTarget(target);
  orbitCam.setMode("follow");

  return true;
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

    const w = container.clientWidth;
    const h = container.clientHeight;

    // ① メインビュー
    renderer.setViewport(0, 0, w, h);
    renderer.setScissorTest(false);
    renderer.render(scene, orbitCam.camera);

    // ② 小窓カメラ（選択されているドローンのフロントカメラのみをレンダリング）
    if (runtimeOptions.enableAttachedCameras && drones.length > 0) {
      const activeDrone = orbitCam.followTarget || drones[0];
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
