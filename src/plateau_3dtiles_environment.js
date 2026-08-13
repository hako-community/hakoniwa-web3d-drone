import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFCesiumRTCExtension } from "3d-tiles-renderer/gltf-cesium-rtc";

export const PLATEAU_3DTILES_ENVIRONMENT_VERSION = 7;

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

function ecefFromGeodetic(latitudeDeg, longitudeDeg, heightM = 0) {
  const latitude = THREE.MathUtils.degToRad(Number(latitudeDeg));
  const longitude = THREE.MathUtils.degToRad(Number(longitudeDeg));
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return new THREE.Vector3(
    (n + heightM) * cosLat * cosLon,
    (n + heightM) * cosLat * sinLon,
    (n * (1 - WGS84_E2) + heightM) * sinLat,
  );
}

// ECEF -> Hakoniwa Three.js local frame: X=east, Y=up, Z=south (-north).
export function buildEcefToHakoniwaMatrix({ latitude, longitude, heightM = 0 }) {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    throw new Error("[PLATEAU 3D Tiles] origin.latitude and origin.longitude are required.");
  }
  const lat = THREE.MathUtils.degToRad(Number(latitude));
  const lon = THREE.MathUtils.degToRad(Number(longitude));
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const origin = ecefFromGeodetic(latitude, longitude, Number(heightM) || 0);
  const east = new THREE.Vector3(-sinLon, cosLon, 0);
  const up = new THREE.Vector3(cosLat * cosLon, cosLat * sinLon, sinLat);
  const south = new THREE.Vector3(sinLat * cosLon, sinLat * sinLon, -cosLat);

  return new THREE.Matrix4().set(
    east.x, east.y, east.z, -east.dot(origin),
    up.x, up.y, up.z, -up.dot(origin),
    south.x, south.y, south.z, -south.dot(origin),
    0, 0, 0, 1,
  );
}

function buildWideGround(config = {}, center = new THREE.Vector3()) {
  const sizeM = Math.max(100, Number(config.sizeM) || 5000);
  const elevationM = Number(config.elevationM) || 0;
  const color = config.color ?? "#8a9b88";
  const group = new THREE.Group();
  group.name = "wide-area-ground";
  group.position.set(center.x, 0, center.z);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(sizeM, sizeM, 1, 1),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = elevationM;
  plane.receiveShadow = true;
  group.add(plane);

  if (config.grid !== false) {
    const divisions = Math.max(2, Math.floor(Number(config.gridDivisions) || 20));
    const grid = new THREE.GridHelper(sizeM, divisions, 0x526b72, 0x6f8385);
    grid.position.y = elevationM + 0.35;
    if (Array.isArray(grid.material)) {
      grid.material.forEach((material) => { material.opacity = 0.38; material.transparent = true; });
    } else {
      grid.material.opacity = 0.38;
      grid.material.transparent = true;
    }
    group.add(grid);
  }
  return group;
}

export async function buildPlateau3DTilesEnvironment(envCfg = {}) {
  const sources = Array.isArray(envCfg.sources) ? envCfg.sources.filter((source) => source?.url) : [];
  if (sources.length === 0) {
    throw new Error("[PLATEAU 3D Tiles] at least one sources[].url is required.");
  }
  const { TilesRenderer } = await import("3d-tiles-renderer");
  const root = new THREE.Group();
  root.name = envCfg.name ?? "plateau-wide-area";
  const verticalOffsetM = Number(envCfg.verticalOffsetM) || 0;
  root.position.y = verticalOffsetM;
  const origin = envCfg.origin ?? {};
  const ecefToLocal = buildEcefToHakoniwaMatrix({
    latitude: origin.latitude,
    longitude: origin.longitude,
    heightM: origin.heightM ?? 0,
  });
  const diagnostics = {
    name: envCfg.name ?? "plateau-wide-area",
    type: "plateau-3dtiles",
    status: "streaming",
    sourceCount: sources.length,
    readySourceCount: 0,
    loadedModelCount: 0,
    visibleTileCount: 0,
    errorCount: 0,
    errorTarget: Number(envCfg.errorTarget) || 24,
    sourceIds: sources.map((source) => source.id ?? source.url),
    originHeightM: Number(origin.heightM) || 0,
    verticalOffsetM,
    verticalReference: envCfg.verticalReference ?? null,
  };
  const tilesRenderers = [];
  const rendererSources = [];
  const readySources = new Set();
  const dracoDecoderPath = envCfg.dracoDecoderPath
    ?? "https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/";
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(dracoDecoderPath);
  dracoLoader.setWorkerLimit(Math.max(1, Number(envCfg.dracoWorkerLimit) || 2));
  dracoLoader.preload();
  diagnostics.draco = { enabled: true, decoderPath: dracoDecoderPath };
  diagnostics.coordinateExtension = "CESIUM_RTC";
  const clipSizeM = Math.max(100, Number(envCfg.clipSizeM ?? envCfg.ground?.sizeM) || 5000);
  const clipCenter = envCfg.clipCenter ?? origin;
  const clipCenterLocal = ecefFromGeodetic(
    clipCenter.latitude ?? origin.latitude,
    clipCenter.longitude ?? origin.longitude,
    clipCenter.heightM ?? origin.heightM ?? 0,
  ).applyMatrix4(ecefToLocal);
  const halfClipSizeM = clipSizeM / 2;
  const clippingPlanes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), halfClipSizeM - clipCenterLocal.x),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), halfClipSizeM + clipCenterLocal.x),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), halfClipSizeM - clipCenterLocal.z),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), halfClipSizeM + clipCenterLocal.z),
  ];
  const cacheMaxSize = Math.max(16, Math.floor(Number(envCfg.cacheMaxSize) || 48));
  const cacheMinSize = Math.min(cacheMaxSize, Math.max(8, Math.floor(Number(envCfg.cacheMinSize) || 32)));
  const preloadConfig = envCfg.preload ?? {};
  const preloadEnabled = preloadConfig.enabled !== false;
  const preloadMarginM = Math.max(0, Number(preloadConfig.marginM) || 100);
  const preloadHalfSizeM = halfClipSizeM + preloadMarginM;
  const preloadHeightM = Math.max(clipSizeM, Number(preloadConfig.heightM) || 7000);
  const preloadResolution = Math.max(256, Math.floor(Number(preloadConfig.resolution) || 1600));
  const preloadCamera = preloadEnabled
    ? new THREE.OrthographicCamera(
      -preloadHalfSizeM,
      preloadHalfSizeM,
      preloadHalfSizeM,
      -preloadHalfSizeM,
      1,
      preloadHeightM + 1000,
    )
    : null;
  if (preloadCamera) {
    preloadCamera.name = "plateau-5km-preload-camera";
    preloadCamera.position.set(clipCenterLocal.x, preloadHeightM, clipCenterLocal.z);
    preloadCamera.up.set(0, 0, -1);
    preloadCamera.lookAt(clipCenterLocal.x, 0, clipCenterLocal.z);
    preloadCamera.updateProjectionMatrix();
    preloadCamera.updateMatrixWorld(true);
  }
  diagnostics.clipSizeM = clipSizeM;
  diagnostics.clipCenterLocalM = {
    x: Number(clipCenterLocal.x.toFixed(3)),
    z: Number(clipCenterLocal.z.toFixed(3)),
  };
  diagnostics.culling = "tile-bounds-plus-material-aoi-square";
  diagnostics.cache = { maxSizePerSource: cacheMaxSize, minSizePerSource: cacheMinSize };
  diagnostics.preload = {
    enabled: preloadEnabled,
    resolution: preloadResolution,
    marginM: preloadMarginM,
    heightM: preloadHeightM,
  };

  if (envCfg.ground?.enabled !== false) {
    root.add(buildWideGround(envCfg.ground, clipCenterLocal));
  }

  for (const source of sources) {
    const tiles = new TilesRenderer(source.url);
    tiles.errorTarget = diagnostics.errorTarget;
    tiles.fetchOptions = { mode: "cors" };
    tiles.lruCache.maxSize = cacheMaxSize;
    tiles.lruCache.minSize = cacheMinSize;
    tiles.lruCache.unloadPercent = 0.25;
    tiles.downloadQueue.maxJobs = Math.max(1, Math.floor(Number(envCfg.downloadJobsPerSource) || 2));
    const gltfLoader = new GLTFLoader(tiles.manager);
    gltfLoader.setDRACOLoader(dracoLoader);
    // PLATEAU B3DM payloads keep their high-precision ECEF origin in the
    // glTF CESIUM_RTC extension. A custom GLTFLoader is needed for Draco, so
    // register RTC explicitly as well or the meshes remain near (0, 0, 0)
    // before the ECEF-to-local matrix is applied and are rendered off-screen.
    gltfLoader.register(() => new GLTFCesiumRTCExtension());
    tiles.manager.addHandler(/\.gltf$/i, gltfLoader);
    tiles.group.name = `plateau-3dtiles-${source.id ?? tilesRenderers.length + 1}`;
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(ecefToLocal);
    tiles.group.updateMatrixWorld(true);
    const tileInView = tiles.tileInView.bind(tiles);
    const tileSphere = new THREE.Sphere();
    const localCenter = new THREE.Vector3();
    tiles.tileInView = (tile) => {
      if (!tileInView(tile)) return false;
      const boundingVolume = tile?.cached?.boundingVolume;
      if (!boundingVolume?.getSphere) return true;
      boundingVolume.getSphere(tileSphere);
      localCenter.copy(tileSphere.center).applyMatrix4(ecefToLocal);
      const nearestX = THREE.MathUtils.clamp(
        localCenter.x,
        clipCenterLocal.x - halfClipSizeM,
        clipCenterLocal.x + halfClipSizeM,
      );
      const nearestZ = THREE.MathUtils.clamp(
        localCenter.z,
        clipCenterLocal.z - halfClipSizeM,
        clipCenterLocal.z + halfClipSizeM,
      );
      const dx = localCenter.x - nearestX;
      const dz = localCenter.z - nearestZ;
      return dx * dx + dz * dz <= tileSphere.radius * tileSphere.radius;
    };
    tiles.addEventListener("load-tile-set", () => {
      readySources.add(source.id ?? source.url);
      diagnostics.readySourceCount = readySources.size;
      diagnostics.status = diagnostics.readySourceCount === diagnostics.sourceCount ? "ready" : "streaming";
    });
    tiles.addEventListener("load-model", ({ scene }) => {
      diagnostics.loadedModelCount += 1;
      scene.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = false;
        object.receiveShadow = true;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material) continue;
          material.clippingPlanes = clippingPlanes;
          material.clipIntersection = false;
          material.needsUpdate = true;
        }
      });
    });
    tiles.addEventListener("dispose-model", () => {
      diagnostics.loadedModelCount = Math.max(0, diagnostics.loadedModelCount - 1);
    });
    tiles.manager.onError = (url) => {
      diagnostics.errorCount += 1;
      diagnostics.lastErrorUrl = url;
      console.warn(`[PLATEAU 3D Tiles] failed to load: ${url}`);
    };
    root.add(tiles.group);
    tilesRenderers.push(tiles);
    rendererSources.push(source);
  }

  return {
    object3d: root,
    diagnostics,
    bindViewer(camera, renderer) {
      renderer.localClippingEnabled = true;
      for (const tiles of tilesRenderers) {
        tiles.setCamera(camera);
        tiles.setResolutionFromRenderer(camera, renderer);
        if (preloadCamera) {
          tiles.setCamera(preloadCamera);
          tiles.setResolution(preloadCamera, preloadResolution, preloadResolution);
        }
      }
    },
    resize(camera, renderer) {
      for (const tiles of tilesRenderers) {
        tiles.setResolutionFromRenderer(camera, renderer);
      }
    },
    update() {
      if (!root.visible) return;
      root.updateMatrixWorld(true);
      let visibleTileCount = 0;
      for (const tiles of tilesRenderers) {
        tiles.update();
        visibleTileCount += tiles.visibleTiles?.size ?? 0;
      }
      diagnostics.visibleTileCount = visibleTileCount;
      diagnostics.sourceStats = tilesRenderers.map((tiles, index) => ({
        id: rendererSources[index]?.id ?? String(index + 1),
        cached: tiles.lruCache?.itemSet?.size ?? null,
        active: tiles.activeTiles?.size ?? 0,
        visible: tiles.visibleTiles?.size ?? 0,
        downloading: tiles.stats?.downloading ?? 0,
        parsing: tiles.stats?.parsing ?? 0,
        failed: tiles.stats?.failed ?? 0,
      }));
    },
  };
}
