import * as THREE from "three";

const SCOPE_STYLES = {
  local: {
    markerSizeM: 6,
    selectedWidthM: 24,
    selectedHeightM: 6,
    markerOffsetM: 12,
    beaconLengthM: 55,
    trailMaxPoints: 120,
  },
  wide: {
    markerSizeM: 110,
    selectedWidthM: 760,
    selectedHeightM: 190,
    markerOffsetM: 150,
    beaconLengthM: 180,
    trailMaxPoints: 180,
  },
};

function createMarkerTexture(label, selected) {
  const canvas = document.createElement("canvas");
  canvas.width = selected ? 512 : 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const color = selected ? "#ffd23f" : "#22d3ee";
  ctx.strokeStyle = "rgba(3, 12, 20, 0.92)";
  ctx.lineWidth = selected ? 18 : 14;
  ctx.fillStyle = "rgba(3, 12, 20, 0.76)";
  ctx.beginPath();
  ctx.arc(64, 64, 39, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 10 : 9;
  ctx.beginPath();
  ctx.arc(64, 64, 34, 0, Math.PI * 2);
  ctx.moveTo(64, 11);
  ctx.lineTo(64, 117);
  ctx.moveTo(11, 64);
  ctx.lineTo(117, 64);
  ctx.stroke();

  if (selected) {
    ctx.fillStyle = "rgba(3, 12, 20, 0.88)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.rect(120, 20, 380, 88);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(label), 310, 64, 350);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class DroneOperationalVisualization {
  constructor(scene, droneId) {
    this.scene = scene;
    this.droneId = String(droneId);
    this.scope = "local";
    this.selected = false;
    this.elapsedSeconds = 0;
    this.sampleElapsedSeconds = 0;
    this.lastSamplePosition = null;
    this.trailPoints = [];

    this.normalTexture = createMarkerTexture(this.droneId, false);
    this.selectedTexture = createMarkerTexture(this.droneId, true);
    this.markerMaterial = new THREE.SpriteMaterial({
      map: this.normalTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.marker = new THREE.Sprite(this.markerMaterial);
    this.marker.name = `${this.droneId}-operational-marker`;
    this.marker.renderOrder = 1000;
    scene.add(this.marker);

    this.beaconGeometry = new THREE.BufferGeometry();
    this.beaconMaterial = new THREE.LineBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.65,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.beacon = new THREE.Line(this.beaconGeometry, this.beaconMaterial);
    this.beacon.name = `${this.droneId}-altitude-beacon`;
    this.beacon.frustumCulled = false;
    scene.add(this.beacon);

    this.trailGeometry = new THREE.BufferGeometry();
    this.trailMaterial = new THREE.LineBasicMaterial({
      color: 0xffd23f,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.trail = new THREE.Line(this.trailGeometry, this.trailMaterial);
    this.trail.name = `${this.droneId}-selected-flight-trail`;
    this.trail.renderOrder = 990;
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    scene.add(this.trail);

    this.setScope("local");
  }

  setScope(scope) {
    this.scope = scope === "wide" ? "wide" : "local";
    this._applyStyle();
  }

  setSelected(selected) {
    const next = !!selected;
    if (this.selected === next) return;
    this.selected = next;
    this.markerMaterial.map = next ? this.selectedTexture : this.normalTexture;
    this.markerMaterial.needsUpdate = true;
    this.marker.center.set(next ? 0.125 : 0.5, 0.5);
    this.beaconMaterial.color.setHex(next ? 0xffd23f : 0x22d3ee);
    this.beaconMaterial.opacity = next ? 0.95 : 0.55;
    this.trail.visible = next && this.trailPoints.length >= 2;
    if (next) this._rebuildTrail();
    this._applyStyle();
  }

  _applyStyle() {
    const style = SCOPE_STYLES[this.scope];
    if (this.selected) {
      this.marker.scale.set(style.selectedWidthM, style.selectedHeightM, 1);
    } else {
      this.marker.scale.set(style.markerSizeM, style.markerSizeM, 1);
    }
    this.beaconGeometry.setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -style.beaconLengthM, 0),
    ]);
  }

  _recordTrail(worldPosition, dt) {
    this.sampleElapsedSeconds += dt;
    const moved = this.lastSamplePosition?.distanceTo(worldPosition) ?? Infinity;
    if (this.sampleElapsedSeconds < 0.5 && moved < 4) return;
    this.sampleElapsedSeconds = 0;
    const point = worldPosition.clone();
    point.y += 1.5;
    this.trailPoints.push(point);
    this.lastSamplePosition = worldPosition.clone();
    const maxPoints = SCOPE_STYLES[this.scope].trailMaxPoints;
    if (this.trailPoints.length > maxPoints) {
      this.trailPoints.splice(0, this.trailPoints.length - maxPoints);
    }
    if (this.selected) this._rebuildTrail();
  }

  _rebuildTrail() {
    this.trailGeometry.setFromPoints(this.trailPoints);
    this.trail.visible = this.selected && this.trailPoints.length >= 2;
  }

  update(worldPosition, dt) {
    if (!worldPosition) return;
    const style = SCOPE_STYLES[this.scope];
    this.elapsedSeconds += dt;
    this._recordTrail(worldPosition, dt);

    this.marker.position.copy(worldPosition);
    this.marker.position.y += style.markerOffsetM;
    const pulse = this.selected ? 1 + Math.sin(this.elapsedSeconds * 4) * 0.08 : 1;
    if (this.selected) {
      this.marker.scale.set(
        style.selectedWidthM * pulse,
        style.selectedHeightM * pulse,
        1,
      );
    }

    this.beacon.position.copy(worldPosition);
  }
}
