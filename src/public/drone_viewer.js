import { main, getDrones, getEnvironmentDiagnostics, focusDroneById, getFocusedDroneId, resizeViewer, setBeforeDronesUpdateHook, setViewerRuntimeOptions, setCameraFollowEnabled, setEnvironmentScope, getEnvironmentScope, setOperationalSelectedDroneId } from "../app.js?v=phase-e-20260813-13";
import { loadSceneProfileCatalog } from "../loader.js";
import { DroneRenderManager } from "./drone_render_manager.js";
import { FaultInjectionState } from "../fault_injection/fault_injection_state.js";
import { TERRAIN_GRID_ENVIRONMENT_VERSION } from "../terrain_environment.js?v=r2-20260809-6";
import { MJCF_BUILDING_GEOMETRY_VERSION } from "../mjcf_building.js?v=r3-20260809-2";
import { LOD1_CITY_ENVIRONMENT_VERSION } from "../lod1_city_environment.js?v=phase-e-20260812-1";
import { PLATEAU_3DTILES_ENVIRONMENT_VERSION } from "../plateau_3dtiles_environment.js?v=phase-e-20260813-10";

export { TERRAIN_GRID_ENVIRONMENT_VERSION, MJCF_BUILDING_GEOMETRY_VERSION, LOD1_CITY_ENVIRONMENT_VERSION, PLATEAU_3DTILES_ENVIRONMENT_VERSION };
export const SELECTION_SYNC_API_VERSION = 1;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function validateViewerConfig(config) {
  if (config.version !== "1.0") {
    throw new Error(`[DroneViewer] Unsupported viewer config version: ${config.version}`);
  }
  if (!config.three?.sceneConfigPath) {
    throw new Error("[DroneViewer] three.sceneConfigPath is required.");
  }
  if (!config.pdu?.pduDefPath) {
    throw new Error("[DroneViewer] pdu.pduDefPath is required.");
  }
  if (!config.pdu?.wsUri) {
    throw new Error("[DroneViewer] pdu.wsUri is required.");
  }
  const mode = config.stateInput?.mode;
  if (mode !== "legacy" && mode !== "fleets") {
    throw new Error(`[DroneViewer] Invalid stateInput.mode: ${mode}`);
  }
  if (mode === "legacy") {
    if (!config.stateInput?.legacy?.roleMap?.pos || !config.stateInput?.legacy?.roleMap?.motor) {
      throw new Error("[DroneViewer] stateInput.legacy.roleMap.pos/motor are required.");
    }
  }
  if (mode === "fleets") {
    if (!config.stateInput?.fleets?.roleMap?.visual_state_array) {
      throw new Error("[DroneViewer] stateInput.fleets.roleMap.visual_state_array is required.");
    }
    if (config.pdu?.wireVersion !== "v2") {
      throw new Error("[DroneViewer] fleets mode requires pdu.wireVersion=v2.");
    }
    if (config.stateInput?.fleets?.dynamicSpawn != null && typeof config.stateInput.fleets.dynamicSpawn !== "boolean") {
      throw new Error("[DroneViewer] stateInput.fleets.dynamicSpawn must be boolean.");
    }
    if (config.stateInput?.fleets?.templateDroneIndex != null) {
      const n = config.stateInput.fleets.templateDroneIndex;
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("[DroneViewer] stateInput.fleets.templateDroneIndex must be an integer >= 0.");
      }
    }
    if (config.stateInput?.fleets?.maxDynamicDrones != null) {
      const n = config.stateInput.fleets.maxDynamicDrones;
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("[DroneViewer] stateInput.fleets.maxDynamicDrones must be an integer > 0.");
      }
    }
  }
  if (config.ui?.statePanelIntervalMsec != null) {
    const v = config.ui.statePanelIntervalMsec;
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error("[DroneViewer] ui.statePanelIntervalMsec must be a positive integer.");
    }
  }
  if (config.ui?.enableAttachedCameras != null && typeof config.ui.enableAttachedCameras !== "boolean") {
    throw new Error("[DroneViewer] ui.enableAttachedCameras must be boolean.");
  }
  if (config.ui?.enableMainCameraMouseControl != null && typeof config.ui.enableMainCameraMouseControl !== "boolean") {
    throw new Error("[DroneViewer] ui.enableMainCameraMouseControl must be boolean.");
  }
}

export class DroneViewer {
  constructor(config = {}) {
    this.initialized = false;
    this.viewerConfig = null;
    this.stateSource = null;
    this.renderManager = null;
    this.faultInjectionState = new FaultInjectionState();
    this.disturbanceWriter = null;
    this.pduRuntime = null;
    this.syncHookInstalled = false;
    this.syncInFlight = false;
    this.runtimeSelection = null;
    if (config && Object.keys(config).length > 0) {
      this.configure(config);
    }
  }

  configure(partialConfig = {}) {
    validateViewerConfig(partialConfig);
    this.viewerConfig = deepClone(partialConfig);
  }

  getViewerConfig() {
    return deepClone(this.viewerConfig);
  }

  async loadPduRuntime() {
    if (this.pduRuntime) return this.pduRuntime;
    const [hakoniwaModule, factoryModule, writerModule] = await Promise.all([
      import("../hakoniwa/hakoniwa-pdu.js?v=r8-core-20260811-5"),
      import("../state_source/state_source_factory.js?v=r8-core-20260811-5"),
      import("../fault_injection/disturbance_writer.js?v=r8-core-20260811-5"),
    ]);
    this.pduRuntime = {
      Hakoniwa: hakoniwaModule.Hakoniwa,
      StateSourceFactory: factoryModule.StateSourceFactory,
    };
    this.disturbanceWriter = new writerModule.DisturbanceWriter();
    return this.pduRuntime;
  }

  async listDroneProfiles({ droneConfigPath } = {}) {
    const resolvedSceneConfigPath = droneConfigPath ?? this.viewerConfig?.three?.sceneConfigPath;
    if (!resolvedSceneConfigPath) {
      throw new Error("[DroneViewer] sceneConfigPath is required to list drone profiles.");
    }
    return await loadSceneProfileCatalog(resolvedSceneConfigPath);
  }

  async initialize({ droneConfigPath, droneProfileId, environmentMode } = {}) {
    if (this.initialized) {
      return true;
    }
    const resolvedSceneConfigPath = droneConfigPath ?? this.viewerConfig?.three?.sceneConfigPath;
    if (!resolvedSceneConfigPath) {
      throw new Error("[DroneViewer] sceneConfigPath is required (argument or viewerConfig.three.sceneConfigPath).");
    }
    setViewerRuntimeOptions({
      enableAttachedCameras: this.viewerConfig?.ui?.enableAttachedCameras,
      enableMainCameraMouseControl: this.viewerConfig?.ui?.enableMainCameraMouseControl,
    });
    const fleetOptions = this.viewerConfig?.stateInput?.fleets ?? {};
    this.runtimeSelection = await main(resolvedSceneConfigPath, {
      dynamicSpawn: this.viewerConfig?.stateInput?.mode === "fleets" && !!fleetOptions.dynamicSpawn,
      templateDroneIndex: fleetOptions.templateDroneIndex ?? 0,
      maxDynamicDrones: fleetOptions.maxDynamicDrones ?? 1,
      droneProfileId,
      environmentMode,
    });
    this.renderManager = new DroneRenderManager({ getDrones });
    if (!this.syncHookInstalled) {
      setBeforeDronesUpdateHook(() => {
        if (this.syncInFlight) return;
        this.syncInFlight = true;
        this.syncDroneStates()
          .catch((e) => {
            console.error("[DroneViewer] syncDroneStates failed:", e);
          })
          .finally(() => {
            this.syncInFlight = false;
          });
      });
      this.syncHookInstalled = true;
    }
    this.initialized = true;
    return true;
  }

  async connectPdu({
    pduDefPath,
    wsUri,
    wireVersion,
  } = {}) {
    const { Hakoniwa, StateSourceFactory } = await this.loadPduRuntime();
    const resolvedPduDefPath = pduDefPath ?? this.viewerConfig?.pdu?.pduDefPath;
    const resolvedWsUri = wsUri ?? this.viewerConfig?.pdu?.wsUri;
    const resolvedWireVersion = wireVersion ?? this.viewerConfig?.pdu?.wireVersion ?? "v2";
    const mode = this.viewerConfig?.stateInput?.mode;
    if (!resolvedPduDefPath) {
      throw new Error("[DroneViewer] pduDefPath is required (argument or viewerConfig.pdu.pduDefPath).");
    }
    if (!resolvedWsUri) {
      throw new Error("[DroneViewer] wsUri is required (argument or viewerConfig.pdu.wsUri).");
    }
    if (mode === "fleets" && resolvedWireVersion !== "v2") {
      throw new Error("[DroneViewer] fleets mode requires pdu.wireVersion=v2.");
    }
    Hakoniwa.configure({
      pdu_def_path: resolvedPduDefPath,
      ws_uri: resolvedWsUri,
      wire_version: resolvedWireVersion,
    });
    const connected = await Hakoniwa.connect();
    if (!connected) {
      return false;
    }
    this.stateSource = StateSourceFactory.create(this.viewerConfig);
    await this.stateSource.initialize({ pduDefPath: resolvedPduDefPath });
    return true;
  }

  async disconnectPdu() {
    if (this.stateSource) {
      await this.stateSource.dispose();
    }
    this.stateSource = null;
    if (this.pduRuntime) {
      await this.pduRuntime.Hakoniwa.disconnect();
    }
  }

  async initDronePdu() {
    const drones = getDrones();
    if (!this.stateSource) {
      throw new Error("[DroneViewer] stateSource is not initialized. Call connectPdu() first.");
    }
    for (const drone of drones) {
      await this.stateSource.bindDrone(drone.droneId);
    }
  }

  async syncDroneStates() {
    if (!this.stateSource) return;
    await this.stateSource.update();
    if (!this.renderManager) return;
    const statesByDroneId = new Map();
    for (const drone of getDrones()) {
      const state = this.stateSource.getState(drone.droneId);
      if (state) {
        statesByDroneId.set(String(drone.droneId), state);
      }
    }
    this.renderManager.applyStates(statesByDroneId);
  }

  getDrones() {
    return getDrones();
  }

  getEnvironmentDiagnostics() {
    return getEnvironmentDiagnostics();
  }

  getRuntimeSelection() {
    return deepClone(this.runtimeSelection);
  }

  getDroneStates() {
    return getDrones()
      .filter((d) => d && d.latestPose && d.latestPose.rosPos && d.latestPose.rosRpyDeg)
      .map((d, index) => ({
        id: d.droneId ?? index,
        name: d.cfg?.name ?? String(d.droneId ?? index),
        positionRos: [...d.latestPose.rosPos],
        rpyDeg: [...d.latestPose.rosRpyDeg],
        pwmDuty: [...(d.pwmDuty ?? [])],
        rotorSpeedRadPerSec: d.rotorSpeed ?? 0,
        rotorSpeedsRadPerSec: [...(d.rotorSpeeds ?? [])],
        collidedCounts: d.collidedCounts,
        impulseCollision: d.impulseCollision
          ? deepClone(d.impulseCollision)
          : null,
      }));
  }

  getStateSourceDiagnostics() {
    const source = this.stateSource?.getDiagnostics?.() ?? null;
    const transport = this.pduRuntime?.Hakoniwa?.getDiagnostics?.() ?? null;
    return source ? { ...source, transport } : { transport };
  }

  focusDroneById(droneId, options = {}) {
    return focusDroneById(droneId, options);
  }

  getFocusedDroneId() {
    return getFocusedDroneId();
  }

  setSelectedDroneId(droneId) {
    return setOperationalSelectedDroneId(droneId);
  }

  resize() {
    return resizeViewer();
  }

  setFollowSelectedEnabled(enabled) {
    return setCameraFollowEnabled(!!enabled);
  }

  setEnvironmentScope(scope, options = {}) {
    return setEnvironmentScope(scope, options);
  }

  getEnvironmentScope() {
    return getEnvironmentScope();
  }

  getRotorFaultScales() {
    return this.faultInjectionState.getRotorScales();
  }

  setRotorFaultScales(scales = []) {
    return this.faultInjectionState.setRotorScales(scales);
  }

  setRotorFaultScale(index, scale) {
    return this.faultInjectionState.setRotorScale(index, scale);
  }

  resetRotorFaultScales() {
    const next = this.faultInjectionState.reset();
    return next.rotorScales;
  }

  async sendRotorFaultScales(scales = null) {
    await this.loadPduRuntime();
    const effectiveScales = Array.isArray(scales)
      ? this.faultInjectionState.setRotorScales(scales)
      : this.faultInjectionState.getRotorScales();
    return await this.disturbanceWriter.write({
      rotorScales: effectiveScales,
      wind: this.faultInjectionState.getWind(),
    });
  }

  getWind() {
    return this.faultInjectionState.getWind();
  }

  setWind({ headingDeg, speedMps } = {}) {
    return this.faultInjectionState.setWind({ headingDeg, speedMps });
  }

  setWindHeadingDeg(headingDeg) {
    return this.faultInjectionState.setWindHeadingDeg(headingDeg);
  }

  setWindSpeedMps(speedMps) {
    return this.faultInjectionState.setWindSpeedMps(speedMps);
  }

  async sendCurrentDisturbance() {
    await this.loadPduRuntime();
    return await this.disturbanceWriter.write({
      rotorScales: this.faultInjectionState.getRotorScales(),
      wind: this.faultInjectionState.getWind(),
    });
  }
}

export function createDroneViewer(config = {}) {
  return new DroneViewer(config);
}
