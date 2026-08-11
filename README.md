# hakoniwa-web3d-drone

Hakoniwa Droneの状態をThree.jsで表示する、ブラウザ向け3D Viewerコンポーネントです。

単体ページとして利用できるほか、`createDroneViewer()`公開APIを通して
`hakoniwa-geo-viewer`など別のWeb UIへ組み込めます。機体単位の従来PDU入力
`legacy`と、`DroneVisualStateArray`を使う複数機入力`fleets`に対応します。

## 主な機能

- Three.js r160による機体・地形・建物の描画
- `legacy` / `fleets`状態入力
- 複数機の動的スポーン、選択、追従カメラ
- Viewer configとscene configによる表示構成の切替
- glTF/GLB機体モデルとローターアニメーション
- terrain-gridからの局所地形メッシュ生成
- MJCF `geom_bldg_*` boxの`InstancedMesh`表示
- `physics` / `visual` / `none`環境モード
- WebSocket経由のHakoniwa PDU受信
- 風・ローター出力倍率の故障注入UI
- 外部UI向けの選択・状態・診断API

## 責任範囲

このリポジトリが担当するもの:

- ドローンと局所環境のThree.js描画
- Viewer、scene、機体プロファイル設定の読み込み
- WebSocket PDU入力とブラウザ内の状態適用
- 機体選択、カメラ、表示診断
- 他Web UIへ組み込むための公開API

このリポジトリが担当しないもの:

- ドローンの物理計算、制御、センサ計算
- Hakoniwaの時刻・ライフサイクル管理
- shared-memory PDUからWebSocketへの変換
- PLATEAU、MJCF、DEM等の生成と配布
- Mapray/Leafletを使う地理空間表示

## データ経路

```text
Hakoniwa Drone / state publisher
            |
            v
    shared-memory PDU
            |
            v
  WebSocket Bridge (:8765)
            |
            v
  hakoniwa-web3d-drone
            |
            v
 Three.js local 3D scene
```

## 必要環境

- Python 3.9以上
- WebGL 2を利用できる現在のブラウザ
- recursive cloneされた`hakoniwa-pdu-javascript` submodule
- 実PDUへ接続する場合は互換性のあるWebSocket Bridge

Three.js r160、GLTFLoader、OrbitControls、BufferGeometryUtilsは
`thirdparty/three/`へ固定配置するため、単体起動時にThree.js CDNは不要です。

## クローン

```bash
git clone --recursive https://github.com/hako-community/hakoniwa-web3d-drone.git
cd hakoniwa-web3d-drone
```

既存cloneでsubmoduleを取得する場合:

```bash
git submodule update --init --recursive
```

## 検証と単体起動

```bash
python tools/hako.py doctor
python tools/hako.py test
python tools/hako.py smoke
python tools/hako.py serve --bind localhost --port 18080
```

| コマンド | 内容 |
|---|---|
| `doctor` | Python、必須ファイル、PDU submodule、Viewer設定を確認 |
| `test` | 設定、公開API、地形/MJCF geometry、静的契約を検証 |
| `smoke` | 一時HTTPサーバーでHTML、module、設定、PDU moduleを取得 |
| `serve` | `.mjs`とGLBに対応した開発HTTPサーバーを起動 |

ブラウザで次を開きます。

```text
http://localhost:18080/index.html
```

既定値:

- Viewer config: `/config/viewer-config-legacy.json`
- WebSocket: `ws://127.0.0.1:8765`

WebBridgeが起動していない場合も3D画面と設定は確認できますが、PDU接続は成功しません。

## Viewer設定

URLパラメータ`viewerConfigPath`でViewer設定を切り替えます。

```text
# legacy
http://localhost:18080/index.html?viewerConfigPath=/config/viewer-config-legacy.json

# fleets
http://localhost:18080/index.html?viewerConfigPath=/config/viewer-config-fleets.json
```

URLで上書きできる主な項目:

| パラメータ | 用途 |
|---|---|
| `viewerConfigPath` | Viewer config URL |
| `wsUri` | WebSocket接続先 |
| `wireVersion` | `v1`または`v2` |
| `pduDefPath` | PDU定義URL |
| `dynamicSpawn` | fleetsの動的スポーン |
| `templateDroneIndex` | 動的生成用テンプレート |
| `maxDynamicDrones` | 動的機体数の上限 |
| `droneProfile` | 機体モデルプロファイル |
| `environmentMode` | `physics`、`visual`、`none` |

優先順位はURL、Viewer config、既定値の順です。`fleets`入力では
`pdu.wireVersion: "v2"`が必須です。多数機時はattached cameraを無効にしてください。

関連仕様:

- [Viewer config specification](docs/viewer-config-spec.md)
- [Viewer config schema](config/schema/viewer-config.schema.json)
- [Scene config specification](docs/scene-config-spec.md)
- [Scene config schema](config/schema/scene-config.schema.json)

## 公開Viewer API

```javascript
import { createDroneViewer } from "/src/public/drone_viewer.js";

const viewer = createDroneViewer();
viewer.configure(viewerConfig);

await viewer.initialize({
  droneProfileId: "base",
  environmentMode: "physics",
});

await viewer.connectPdu({ wsUri: "ws://127.0.0.1:8765" });
await viewer.initDronePdu();
```

代表的な公開操作:

- `configure(config)`
- `initialize(options)`
- `connectPdu(options)`
- `initDronePdu()`
- `getDrones()` / `getDroneStates()`
- `focusDroneById(id)`
- `setFollowSelectedEnabled(enabled)`
- `listDroneProfiles(options)`
- `getEnvironmentDiagnostics()`
- `resize()`

`hakoniwa-geo-viewer`はこのAPIを使い、地図上の選択とThree.js追従対象を同期します。

## Scene config

scene configは機体、カメラ、environmentを定義します。

```text
config/
|- viewer-config-legacy.json
|- viewer-config-fleets.json
|- viewer-config-terrain-fixture.json
|- drone_config-1.json
|- drone_config-compact-1.json
|- drone_config-compact-base-1.json
|- drone_config-compact-dji-1.json
|- drone_config-compact-terrain-fixture.json
`- schema/
```

### Terrain grid

`type: "terrain-grid"`は、MuJoCoと共通の`modelHeightsM`格子から
`BufferGeometry`を生成します。

```json
{
  "name": "terrain",
  "type": "terrain-grid",
  "terrainGridPath": "/runtime-assets/shibuya/terrain-grid.json",
  "material": { "mode": "elevation", "wireframe": false },
  "debug": { "grid": false, "axes": false }
}
```

座標変換:

```text
[rosX, rosY, modelZ] -> [-rosY, modelZ, -rosX]
```

`zBaselineM`はMapray絶対標高用のメタデータであり、Three.js geometryへは
加算しません。material modeは`elevation`、`solid`、`wireframe`に対応します。

3×3の小型fixture:

```text
http://localhost:18080/index.html?viewerConfigPath=/config/viewer-config-terrain-fixture.json
```

### MJCF建物

`type: "model"`、`kind: "mjcf"`のenvironmentは、`geom_bldg_*`のboxを解析し、
`InstancedMesh`として描画します。大量の建物ごとに個別Meshを生成しないため、
局所衝突環境を比較的低い描画負荷で確認できます。

環境モード:

- `physics`: terrainとMJCF衝突形状
- `visual`: 任意の表示用GLB。未配置時は警告後にphysicsへフォールバック可能
- `none`: 環境非表示

## モデル資産

標準`base`モデルは`assets/models/`に含まれます。

```text
assets/models/
|- base-drone-frame.glb
|- base-drone-prop.glb
|- base-drone-camera.glb
`- base-floor.glb
```

ライセンスやサイズの都合で配布しないモデルは`assets/local_models/`へ配置し、
Gitへコミットしません。PLATEAU由来資産の生成・配布は`hakoniwa-simenv-data`と
`hakoniwa-geo-viewer`側の責任です。

## UI

- `connect`: WebSocket PDU接続
- Drone selector: 注視対象の選択
- `Follow selected`: 選択機体への追従
- Mouse control: OrbitControlsによるメインカメラ操作
- Drone model: 起動時の機体プロファイル
- 3D environment: `physics` / `visual` / `none`
- Fault injection: ローター出力倍率
- Wind: 風向・風速の送信

## 統合時の注意

- ES module、`.mjs`、GLBを正しいMIME typeで配信する。
- `three`のimport mapと`thirdparty/three`のバージョンを一致させる。
- `hakoniwa-pdu-javascript` submoduleをrecursiveに初期化する。
- 地形、MJCF、機体状態は同じROS/MuJoCo座標契約を使用する。
- 複数機表示では上限を設定し、attached cameraを機体ごとに生成しない。

## 関連リポジトリ

- [hakoniwa-geo-viewer](https://github.com/hako-community/hakoniwa-geo-viewer): Mapray/Leafletとの統合
- [hakoniwa-simenv-data](https://github.com/hako-community/hakoniwa-simenv-data): PLATEAU/MJCF/terrain生成
- `hakoniwa-pdu-javascript`: ブラウザ側PDU通信
- `hakoniwa-pdu-bridge-core`: shared-memory PDUとWebSocketの橋渡し
- `hakoniwa-drone-core`: ドローン物理と状態生成

## ライセンス

ルートのプロジェクトコードとプロジェクト所有モデルは
[PolyForm Noncommercial License 1.0.0](./LICENSE)で提供します。商用利用は
ライセンサーとの別途契約が必要です。

`thirdparty/hakoniwa-pdu-javascript`と`thirdparty/three`には、それぞれの
公開元ライセンスが適用されます。詳細は
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)を参照してください。
