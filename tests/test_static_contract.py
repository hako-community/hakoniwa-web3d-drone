from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class StaticViewerContractTest(unittest.TestCase):
    def test_viewer_configs_are_resolvable(self) -> None:
        configs = sorted((ROOT / "config").glob("viewer-config-*.json"))
        self.assertTrue(configs, "viewer configuration files are required")

        for path in configs:
            with self.subTest(path=path.name):
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual("1.0", data.get("version"))
                self.assertIn(data.get("stateInput", {}).get("mode"), {"legacy", "fleets"})

                for section, key in (("three", "sceneConfigPath"), ("pdu", "pduDefPath")):
                    value = data.get(section, {}).get(key)
                    self.assertIsInstance(value, str)
                    self.assertTrue(value)
                    if value.startswith(("/", "http://", "https://")):
                        continue
                    target = (path.parent / value).resolve()
                    self.assertTrue(target.is_file(), f"{path.name}: missing {section}.{key} target {value}")

    def test_public_viewer_api_used_by_integrators_is_present(self) -> None:
        source = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        for marker in (
            "export class DroneViewer",
            "export function createDroneViewer",
            "configure(partialConfig",
            "async initialize(",
            "async connectPdu(",
            "async initDronePdu(",
            "getDrones()",
            "focusDroneById(",
            "setFollowSelectedEnabled(",
            "getFocusedDroneId()",
            "getStateSourceDiagnostics()",
            "resize()",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, source)
        self.assertIn("this.syncInFlight", source)
        fleet_source = (ROOT / "src/state_source/fleet_state_source.js").read_text(
            encoding="utf-8"
        )
        for marker in ("packetCount", "lastError", "stateCount"):
            self.assertIn(marker, fleet_source)
        singleton_version = "hakoniwa-pdu.js?v=r8-core-20260811-5"
        self.assertIn(singleton_version, source)
        for relative_path in (
            "src/state_source/fleet_state_source.js",
            "src/state_source/legacy_state_source.js",
            "src/fault_injection/disturbance_writer.js",
        ):
            module_source = (ROOT / relative_path).read_text(encoding="utf-8")
            with self.subTest(relative_path=relative_path):
                self.assertIn(singleton_version, module_source)

    def test_fleet_source_exposes_core_sequence_diagnostics(self) -> None:
        source = (ROOT / "src/state_source/fleet_state_source.js").read_text(
            encoding="utf-8"
        )
        for marker in (
            "lastSequenceId",
            "lastPacketReceivedAtMilliseconds",
            "getDiagnostics()",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, source)

    def test_legacy_collision_state_contract(self) -> None:
        config = json.loads(
            (ROOT / "config/viewer-config-legacy.json").read_text(encoding="utf-8")
        )
        role_map = config["stateInput"]["legacy"]["roleMap"]
        self.assertEqual("hako_msgs/DroneStatus", role_map.get("status"))
        self.assertEqual(
            "hako_msgs/ImpulseCollision",
            role_map.get("impulse_collision"),
        )

        schema = json.loads(
            (ROOT / "config/schema/viewer-config.schema.json").read_text(encoding="utf-8")
        )
        role_properties = schema["properties"]["stateInput"]["properties"]["legacy"][
            "properties"
        ]["roleMap"]["properties"]
        self.assertIn("status", role_properties)
        self.assertIn("impulse_collision", role_properties)

        source = (ROOT / "src/state_source/legacy_state_source.js").read_text(
            encoding="utf-8"
        )
        viewer = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        drone = (ROOT / "src/drone.js").read_text(encoding="utf-8")
        for marker in ("pduToJs_DroneStatus", "pduToJs_ImpulseCollision"):
            with self.subTest(marker=marker):
                self.assertIn(marker, source)

        for marker in ("collidedCounts", "impulseCollision"):
            with self.subTest(marker=marker):
                self.assertIn(marker, source)
                self.assertIn(marker, viewer)
                self.assertIn(marker, drone)

    def test_javascript_pdu_submodule_is_initialized(self) -> None:
        for relative in (
            "thirdparty/hakoniwa-pdu-javascript/src/PduManager.js",
            "thirdparty/hakoniwa-pdu-javascript/src/impl/WebSocketCommunicationService.js",
        ):
            with self.subTest(path=relative):
                self.assertTrue((ROOT / relative).is_file())

    def test_terrain_grid_environment_contract(self) -> None:
        fixture = json.loads(
            (ROOT / "tests/fixtures/terrain-grid-3x3.json").read_text(encoding="utf-8")
        )
        self.assertEqual(9, fixture["rows"] * fixture["columns"])
        self.assertEqual(9, len(fixture["modelHeightsM"]))

        geometry = (ROOT / "src/terrain_grid_geometry.mjs").read_text(encoding="utf-8")
        environment = (ROOT / "src/terrain_environment.js").read_text(encoding="utf-8")
        app = (ROOT / "src/app.js").read_text(encoding="utf-8")
        viewer = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        scene = json.loads(
            (ROOT / "config/drone_config-compact-terrain-fixture.json").read_text(
                encoding="utf-8"
            )
        )
        visual_fixture = json.loads(
            (ROOT / "tests/fixtures/terrain-grid-visual-3x3.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            ["terrain-grid", "model"],
            [item["type"] for item in scene["environments"]],
        )
        self.assertEqual(
            "../tests/fixtures/terrain-grid-visual-3x3.json",
            scene["environments"][0]["terrainGridPath"],
        )
        self.assertLessEqual(
            max(visual_fixture["modelHeightsM"])
            / (visual_fixture["xMaxM"] - visual_fixture["xMinM"]),
            0.1,
        )
        self.assertNotIn("base-floor.glb", json.dumps(scene))
        for marker in (
            "[-rosY, modelZ, -rosX]",
            "usesZBaselineInGeometry: false",
            "Uint32Array",
            "triangleCount",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, geometry)
        self.assertIn("THREE.BufferGeometry", environment)
        self.assertIn("terrain_grid_geometry.mjs?v=r2-20260809-6", environment)
        self.assertIn("computeVertexNormals", environment)
        self.assertIn("GridHelper", environment)
        self.assertIn("AxesHelper", environment)
        self.assertIn("getEnvironmentDiagnostics", app)
        self.assertIn("getEnvironmentDiagnostics()", viewer)
        self.assertIn("TERRAIN_GRID_ENVIRONMENT_VERSION", viewer)

    def test_browser_entrypoint_has_no_viewer_index_cycle(self) -> None:
        hakoniwa_pdu = (ROOT / "src/hakoniwa/hakoniwa-pdu.js").read_text(
            encoding="utf-8"
        )
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("from '../index.js'", hakoniwa_pdu)
        self.assertIn("thirdparty/hakoniwa-pdu-javascript/src/PduManager.js", hakoniwa_pdu)
        self.assertIn('id="viewer-init-status"', html)
        self.assertIn("showViewerBootError", html)
        self.assertIn("document.readyState === 'loading'", html)
        self.assertIn("initializeViewerPage();", html)
        self.assertIn('import("./src/app.js?v=r4-20260809-1")', html)
        self.assertIn('import("./src/public/drone_viewer.js?v=r4-20260809-1")', html)
        self.assertNotIn("https://unpkg.com", html)
        self.assertIn("/thirdparty/three/build/three.module.js", html)
        loader = (ROOT / "src/loader.js").read_text(encoding="utf-8")
        self.assertIn('from "three/addons/loaders/GLTFLoader.js"', loader)
        orbit_camera = (ROOT / "src/orbit_camera.js").read_text(encoding="utf-8")
        self.assertIn('from "three/addons/controls/OrbitControls.js"', orbit_camera)
        self.assertTrue(
            (ROOT / "thirdparty/three/examples/jsm/controls/OrbitControls.js").is_file()
        )
        viewer = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        self.assertNotIn('from "../hakoniwa/hakoniwa-pdu.js"', viewer)
        self.assertIn("async loadPduRuntime()", viewer)

    def test_r3_mjcf_building_and_drone_profile_contract(self) -> None:
        scene = json.loads(
            (ROOT / "config/drone_config-compact-terrain-fixture.json").read_text(
                encoding="utf-8"
            )
        )
        building = next(item for item in scene["environments"] if item.get("kind") == "mjcf")
        self.assertEqual(["physics"], building["modes"])
        self.assertEqual("collision-debug", building["material"]["mode"])
        self.assertLess(building["material"]["opacity"], 1.0)
        self.assertEqual("base", scene["defaultDroneProfile"])
        self.assertEqual({"base", "dji-local"}, set(scene["droneProfiles"]))
        self.assertTrue(scene["droneProfiles"]["dji-local"]["optionalAssets"])

        geometry = (ROOT / "src/mjcf_building_geometry.mjs").read_text(encoding="utf-8")
        buildings = (ROOT / "src/mjcf_building.js").read_text(encoding="utf-8")
        loader = (ROOT / "src/loader.js").read_text(encoding="utf-8")
        environment = (ROOT / "src/environment.js").read_text(encoding="utf-8")
        viewer = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        self.assertIn("position: [-y, z, -x]", geometry)
        self.assertIn("scale: [sizeY, sizeZ, sizeX]", geometry)
        self.assertIn("new THREE.InstancedMesh", buildings)
        self.assertIn('renderStrategy: "instanced-mesh"', buildings)
        self.assertIn('mjcf_building_geometry.mjs?v=r3-20260809-2', buildings)
        self.assertIn("selectEnvironmentConfigs", environment)
        self.assertIn('mjcf_building.js?v=r3-20260809-2', environment)
        self.assertIn("applyDroneProfile", loader)
        self.assertIn("loadSceneProfileCatalog", loader)
        self.assertIn("async listDroneProfiles", viewer)

    def test_lod1_city_environment_contract(self) -> None:
        city = (ROOT / "src/lod1_city_environment.js").read_text(encoding="utf-8")
        loader = (ROOT / "src/loader.js").read_text(encoding="utf-8")
        environment = (ROOT / "src/environment.js").read_text(encoding="utf-8")
        viewer = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        self.assertIn("LOD1_CITY_ENVIRONMENT_VERSION", city)
        self.assertIn("THREE.ShapeUtils.triangulateShape", city)
        self.assertIn("THREE.BufferGeometry", city)
        self.assertIn('type: "lod1-city"', city)
        self.assertIn("sourceZMin - zBaselineM", city)
        self.assertIn("zBaselineM,", city)
        self.assertIn("lod1Path", loader)
        self.assertIn("buildLod1CityEnvironment", environment)
        self.assertIn("LOD1_CITY_ENVIRONMENT_VERSION", viewer)
        app = (ROOT / "src/app.js").read_text(encoding="utf-8")
        self.assertIn("HakoniwaFrame.rosPosToThree(cameraTargetRos)", app)
        self.assertNotIn("HakoniwaFrame.rosToThreePosition", app)

    def test_readme_uses_current_operational_contract(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for command in (
            "python tools/hako.py doctor",
            "python tools/hako.py test",
            "python tools/hako.py smoke",
        ):
            with self.subTest(command=command):
                self.assertIn(command, readme)

        self.assertNotIn("mac-main_hako_drone_service", readme)
        self.assertNotIn("run-web-bridge.bash", readme)

    def test_plateau_3dtiles_scope_contract(self) -> None:
        city = (ROOT / "src/plateau_3dtiles_environment.js").read_text(encoding="utf-8")
        environment = (ROOT / "src/environment.js").read_text(encoding="utf-8")
        app = (ROOT / "src/app.js").read_text(encoding="utf-8")
        viewer = (ROOT / "src/public/drone_viewer.js").read_text(encoding="utf-8")
        for marker in (
            "PLATEAU_3DTILES_ENVIRONMENT_VERSION",
            "buildEcefToHakoniwaMatrix",
            'import("3d-tiles-renderer")',
            "tiles.errorTarget",
            "tiles.setResolutionFromRenderer",
            "tiles.update()",
            "DRACOLoader",
            "setDRACOLoader",
            "GLTFCesiumRTCExtension",
            "coordinateExtension",
            "localClippingEnabled",
            "clippingPlanes",
            "lruCache.maxSize",
            "OrthographicCamera",
            "preloadCamera",
            "tiles.setResolution(preloadCamera",
            "sourceStats",
            "rendererSources",
            "originHeightM",
            "verticalReference",
            "verticalOffsetM",
        ):
            self.assertIn(marker, city)
        self.assertIn('environmentType === "plateau-3dtiles"', environment)
        self.assertIn("setEnvironmentScope", app)
        self.assertIn("environment.updateEnvironment", app)
        self.assertIn("setEnvironmentScope(scope", viewer)
        orbit = (ROOT / "src/orbit_camera.js").read_text(encoding="utf-8")
        self.assertIn("maxPolarAngleDeg", orbit)
        self.assertIn("this.controls.enablePan", orbit)


if __name__ == "__main__":
    unittest.main()
