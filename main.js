// Three JS Modules
import * as THREE from "three";

import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

// Post Processing
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

// Debugging Tools
import Stats from "three/examples/jsm/libs/stats.module.js";
import GUI from "three/examples/jsm/libs/lil-gui.module.min.js";

let camera, scene, renderer, composer, controls;
let gui, guiCam;
let room;
let playerRig;
const xrControllers = [];
let xrWelcomePanel = null;
let xrHudPanel = null;
let xrWelcomeCanvas = null;
let xrWelcomeTexture = null;
let xrHudCanvas = null;
let xrHudTexture = null;
let lastXRHudText = "";
let scenarioMode = "guided";
let scenarioDifficulty = "standard";
let exitCompleted = false;
let isLocked = false;
let currentInteractable = null;
let interactionHintDiv;
let messageTimeoutId = null;
let handsGroup;
let shelterZone;
let coverTarget = null;
let awaitingExit = false;
let exitPromptedWithoutScan = false;
const noCoverZones = [];
const toppledBounds = new THREE.Box3();

const clock = new THREE.Clock();
let deltaTime;

// Fixed eye height (in metres).
const EYE_HEIGHT = 1.6;
const EYE_HEIGHT_CROUCH = 1.05;

// ==================== FIRST-PERSON MOVEMENT CONTROLS (WASD) ====================
const moveState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};

const moveSpeed = 2.5;

function onKeyDown(event) {
  switch (event.code) {
    case "KeyW":
      moveState.forward = true;
      break;
    case "KeyS":
      moveState.backward = true;
      break;
    case "KeyA":
      moveState.left = true;
      break;
    case "KeyD":
      moveState.right = true;
      break;
    case "KeyE":
      if (event.repeat) return;
      if (coverActive) {
        coverActive = false;
        coverTarget = null;
        if (renderer && renderer.xr.isPresenting && playerRig) playerRig.position.y = 0;
        else if (camera) camera.position.y = EYE_HEIGHT;
        showMessage("You left the cover area.", 1000);
        return;
      }
      if (isCameraInShelter()) {
        takeCover();
        return;
      }
      if (currentInteractable) handleInteraction(currentInteractable);
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case "KeyW":
      moveState.forward = false;
      break;
    case "KeyS":
      moveState.backward = false;
      break;
    case "KeyA":
      moveState.left = false;
      break;
    case "KeyD":
      moveState.right = false;
      break;
  }
}

function handleInteraction(object) {
  if (object.name === "Door" || object.parent?.name === "DoorGroup") {
    toggleDoor();
    return;
  }

  if (object.name === "shelterZone" || object.name === "desk") {
    takeCover();
  }
}

function toggleDoor() {
  if (!window.doorGroup) return;

  window.isDoorOpen = !window.isDoorOpen;

  if (window.isDoorOpen) {
    window.doorGroup.rotation.y = -Math.PI / 2;
    showMessage("Door opened.", 1000);
  } else {
    window.doorGroup.rotation.y = 0;
    showMessage("Door closed.", 1000);
  }
}

// Keep movement within the room and exit area.
function clampInsideRoom(position) {
  const roomHalfSize = 2.4;
  const wallZ = 2.5;
  const outsideLimitZ = 6.0;
  const doorHalfWidth = 0.5;

  if (position.x > roomHalfSize) position.x = roomHalfSize;
  if (position.x < -roomHalfSize) position.x = -roomHalfSize;

  if (position.z < -roomHalfSize) position.z = -roomHalfSize;
  if (position.z > outsideLimitZ) position.z = outsideLimitZ;

  if (position.z > 2.2 && position.z < 2.8) {
    const inDoorway = Math.abs(position.x) < doorHalfWidth;

    if (!inDoorway) {
      if (position.z < wallZ) position.z = 2.2;
      else position.z = 2.8;
    } else if (!window.isDoorOpen) {
      if (position.z < wallZ) position.z = 2.2;
      else position.z = 2.8;
    }
  }
}

function updateFirstPersonMovement(delta) {
  if (renderer && renderer.xr.isPresenting) {
    updateXRMovement(delta);
    return;
  }
  if (!controls.isLocked) return;
  delta = Math.min(Math.max(delta, 0), 0.05);

  if (coverActive && coverTarget) {
    // Keep the player tucked under cover while crouched
    camera.position.x = coverTarget.x;
    camera.position.z = coverTarget.z;
    camera.position.y = EYE_HEIGHT_CROUCH;
    return;
  }

  if (
    !moveState.forward &&
    !moveState.backward &&
    !moveState.left &&
    !moveState.right
  ) {
    return;
  }

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  direction.y = 0;
  direction.normalize();

  const strafe = new THREE.Vector3();
  strafe.crossVectors(direction, camera.up).normalize();

  const velocity = new THREE.Vector3();

  if (moveState.forward) velocity.add(direction);
  if (moveState.backward) velocity.sub(direction);
  if (moveState.left) velocity.sub(strafe);
  if (moveState.right) velocity.add(strafe);

  if (velocity.lengthSq() === 0) return;

  velocity.normalize().multiplyScalar(moveSpeed * delta);

  camera.position.add(velocity);
  clampInsideRoom(camera.position);
  camera.position.y = coverActive ? EYE_HEIGHT_CROUCH : EYE_HEIGHT;
}

// ==================== AUDIO SYSTEM ====================
let rumbleContext = null;
let rumbleOsc = null;
let rumbleGain = null;
let rumbleFilter = null;
let rumbleSubOsc = null;
let rumbleSubGain = null;
let lastImpactSoundTime = -1;
let ambientLightRef = null;
let hemiLightRef = null;
let ceilingLights = [];
let dustPoints = null;
let dustPositions = null;
let dustSeeds = null;
let dustBursts = [];

function initRumbleAudio() {
  if (rumbleContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  rumbleContext = new AudioContext();

  rumbleOsc = rumbleContext.createOscillator();
  rumbleGain = rumbleContext.createGain();
  rumbleFilter = rumbleContext.createBiquadFilter();

  rumbleOsc.type = "sawtooth";
  rumbleOsc.frequency.value = 30;
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 120;
  rumbleGain.gain.value = 0.0;

  rumbleOsc.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(rumbleContext.destination);

  rumbleOsc.start();

  rumbleSubOsc = rumbleContext.createOscillator();
  rumbleSubGain = rumbleContext.createGain();
  rumbleSubOsc.type = "sine";
  rumbleSubOsc.frequency.value = 47;
  rumbleSubGain.gain.value = 0;
  rumbleSubOsc.connect(rumbleSubGain);
  rumbleSubGain.connect(rumbleContext.destination);
  rumbleSubOsc.start();
}

function updateRumble(intensity) {
  if (!rumbleGain || !rumbleContext) return;
  if (rumbleContext.state === "suspended") {
    rumbleContext.resume();
  }
  const targetGain = Math.min(0.12, 0.015 + intensity * 0.095);
  rumbleGain.gain.setTargetAtTime(targetGain, rumbleContext.currentTime, 0.08);
  if (rumbleSubGain) {
    rumbleSubGain.gain.setTargetAtTime(Math.min(0.045, intensity * 0.035), rumbleContext.currentTime, 0.1);
    rumbleSubOsc.frequency.setTargetAtTime(38 + intensity * 16, rumbleContext.currentTime, 0.12);
  }
}

function stopRumble() {
  if (!rumbleGain || !rumbleContext) return;
  rumbleGain.gain.setTargetAtTime(0.0, rumbleContext.currentTime, 0.12);
  if (rumbleSubGain) rumbleSubGain.gain.setTargetAtTime(0.0, rumbleContext.currentTime, 0.15);
}

function playImpactSound(intensity = 0.7) {
  if (!rumbleContext || rumbleContext.state === "closed") return;
  if (rumbleContext.state === "suspended") rumbleContext.resume();
  const now = rumbleContext.currentTime;
  // Several props can hit together; gently limit overlapping synthetic impacts.
  if (lastImpactSoundTime >= 0 && now - lastImpactSoundTime < 0.085) return;
  lastImpactSoundTime = now;
  const oscillator = rumbleContext.createOscillator();
  const gain = rumbleContext.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(95 + Math.random() * 45, now);
  oscillator.frequency.exponentialRampToValueAtTime(38, now + 0.22);
  gain.gain.setValueAtTime(Math.min(0.16, 0.035 + intensity * 0.08), now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
  oscillator.connect(gain);
  gain.connect(rumbleContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.25);
}

function createDustSystem() {
  if (!scene || dustPoints) return;
  const count = 180;
  dustPositions = new Float32Array(count * 3);
  dustSeeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    dustPositions[i * 3] = randomRange(-2.25, 2.25);
    dustPositions[i * 3 + 1] = randomRange(0.15, 2.85);
    dustPositions[i * 3 + 2] = randomRange(-2.25, 2.25);
    dustSeeds[i] = Math.random() * Math.PI * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xc8c2b5,
    size: 0.025,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    sizeAttenuation: true,
  });
  dustPoints = new THREE.Points(geometry, material);
  dustPoints.frustumCulled = false;
  scene.add(dustPoints);
}

function createDustBurst(position, intensity = 0.7) {
  const xrMode = Boolean(renderer && renderer.xr.isPresenting);
  if (!scene || dustBursts.length >= (xrMode ? 4 : 6)) return;
  const count = xrMode ? 12 : 18;
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = position.x + randomRange(-0.12, 0.12);
    positions[i * 3 + 1] = Math.max(0.05, position.y) + randomRange(0, 0.18);
    positions[i * 3 + 2] = position.z + randomRange(-0.12, 0.12);
    velocities.push(new THREE.Vector3(randomRange(-0.65, 0.65), randomRange(0.25, 1.1) * intensity, randomRange(-0.65, 0.65)));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xbdb7aa,
    size: 0.045,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  dustBursts.push({ points, velocities, age: 0, lifetime: 1.1 + intensity * 0.45 });
}

function updateAtmosphere(intensity, delta, time) {
  const shake = THREE.MathUtils.clamp(intensity, 0, 1.2);
  const xrMode = Boolean(renderer && renderer.xr.isPresenting);
  const dt = Math.min(Math.max(delta, 0), 0.05);
  const easing = 1 - Math.exp(-7 * dt);

  // Smooth target changes avoid per-frame random flashes, which can be uncomfortable in VR.
  const ambientTarget = 1.2 - shake * 0.16;
  const hemisphereTarget = 0.5 - shake * 0.07;
  if (ambientLightRef) ambientLightRef.intensity += (ambientTarget - ambientLightRef.intensity) * easing;
  if (hemiLightRef) hemiLightRef.intensity += (hemisphereTarget - hemiLightRef.intensity) * easing;

  ceilingLights.forEach((light, index) => {
    const flickerPhase = time * (xrMode ? 5.2 : 8.5) + index * 1.73;
    const flickerWave = 0.5 + 0.5 * Math.sin(flickerPhase);
    const flickerLimit = xrMode ? 0.14 : 0.36;
    const flickerAmount = shake > 0.12
      ? Math.min(flickerLimit, shake * (0.035 + flickerWave * 0.22))
      : 0;
    const targetIntensity = Math.max(xrMode ? 0.72 : 0.38, 2.0 * (1 - flickerAmount));
    light.intensity += (targetIntensity - light.intensity) * easing;
  });

  if (dustPoints) {
    const dustOpacityLimit = xrMode ? 0.19 : 0.30;
    dustPoints.material.size = xrMode ? 0.018 : 0.025;
    dustPoints.material.opacity = shake > 0.08
      ? Math.min(dustOpacityLimit, 0.035 + shake * (xrMode ? 0.14 : 0.20))
      : 0;
    dustPoints.visible = dustPoints.material.opacity > 0.01;

    if (dustPoints.visible && dustPositions) {
      const driftScale = xrMode ? 0.7 : 1;
      for (let i = 0; i < dustSeeds.length; i += 1) {
        const offset = i * 3;
        dustPositions[offset] += Math.sin(time * 1.7 + dustSeeds[i]) * dt * (0.08 + shake * 0.25) * driftScale;
        dustPositions[offset + 1] += dt * (0.025 + shake * 0.11);
        dustPositions[offset + 2] += Math.cos(time * 1.4 + dustSeeds[i]) * dt * (0.08 + shake * 0.25) * driftScale;
        if (dustPositions[offset + 1] > 2.95) {
          dustPositions[offset + 1] = 0.12;
          dustPositions[offset] = randomRange(-2.25, 2.25);
          dustPositions[offset + 2] = randomRange(-2.25, 2.25);
        }
      }
      dustPoints.geometry.attributes.position.needsUpdate = true;
    }
  }

  for (let i = dustBursts.length - 1; i >= 0; i -= 1) {
    const burst = dustBursts[i];
    burst.age += dt;
    const positions = burst.points.geometry.attributes.position;
    for (let j = 0; j < burst.velocities.length; j += 1) {
      const velocity = burst.velocities[j];
      velocity.y -= 1.2 * dt;
      positions.array[j * 3] += velocity.x * dt;
      positions.array[j * 3 + 1] += velocity.y * dt;
      positions.array[j * 3 + 2] += velocity.z * dt;
    }
    positions.needsUpdate = true;
    burst.points.material.opacity = Math.max(0, 0.58 * (1 - burst.age / burst.lifetime));
    if (burst.age >= burst.lifetime) {
      scene.remove(burst.points);
      burst.points.geometry.dispose();
      burst.points.material.dispose();
      dustBursts.splice(i, 1);
    }
  }
}

// ==================== PERFORMANCE SETTINGS ====================
const statsEnable = false;
const guiEnable = false;
const toneMapping = THREE.ACESFilmicToneMapping;
const antialiasing = false;
const AmbientOcclusion = false;
const SHADOWS_ENABLED = false;
const ENV_REFLECTION_ENABLED = false;

const assetBase = import.meta.env.BASE_URL ?? "./";
const loader = new GLTFLoader().setPath(`${assetBase}assets/3D/`);
const hdriLoader = new RGBELoader().setPath(`${assetBase}assets/hdri/`);

// ==================== MODEL LOADING ====================
const REALISTIC_MODELS = {
  desk: {
    file: "office_desk.glb",
    position: { x: 0, y: 0, z: -1.5 },
    scale: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  monitor: {
    file: "computer_monitor.glb",
    position: { x: 0, y: 0.9, z: -2 },
    scale: { x: 0.3, y: 0.3, z: 0.3 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  keyboard: {
    file: "mouse_and_keyboard.glb",
    position: { x: -0.2, y: 1.1, z: -1.45 },
    scale: { x: 0.07, y: 0.07, z: 0.07 },
    rotation: { x: 0, y: 0, z: 0 },
  },
  heater: {
    file: "simple_heater.glb",
    position: { x: 0.7, y: 0.2, z: -1.5 },
    scale: { x: 0.05, y: 0.05, z: 0.05 },
    rotation: { x: 0, y: -Math.PI / 2, z: 0 },
  },
  electricalPanel: {
    file: "electrical_panel.glb",
    position: { x: 2.4, y: 1.2, z: -1.8 },
    scale: { x: 0.9, y: 0.9, z: 0.9 },
    rotation: { x: 0, y: -Math.PI / 2, z: 0 },
  },
  chair: {
    file: "office_chair.glb",
    position: { x: 0, y: 0, z: -1 },
    scale: { x: 0.8, y: 0.8, z: 0.8 },
    rotation: { x: 0, y: Math.PI, z: 0 },
  },
  guestChair1: {
    file: "chair.glb",
    position: { x: 2.1, y: 0, z: -0.2 },
    scale: { x: 0.8, y: 0.8, z: 0.8 },
    rotation: { x: 0, y: -Math.PI / 2, z: 0 },
  },
  guestChair2: {
    file: "chair.glb",
    position: { x: 2.1, y: 0, z: -0.8 },
    scale: { x: 0.8, y: 0.8, z: 0.8 },
    rotation: { x: 0, y: -Math.PI / 2, z: 0 },
  },
  plant: {
    file: "majesty_palm_plant.glb",
    position: { x: -2.0, y: 0, z: -2.0 },
    scale: { x: 1.2, y: 1.2, z: 1.2 },
    rotation: { x: 0, y: 0, z: 0 },
  },
};

const loadedModels = {};
let modelsLoaded = false;

function loadModel(modelKey) {
  return new Promise((resolve, reject) => {
    const config = REALISTIC_MODELS[modelKey];
    if (!config) {
      reject(new Error(`Model config not found: ${modelKey}`));
      return;
    }

    loader.load(
      config.file,
      (gltf) => {
        const model = gltf.scene;
        model.position.set(
          config.position.x,
          config.position.y,
          config.position.z
        );
        model.scale.set(config.scale.x, config.scale.y, config.scale.z);
        model.rotation.set(
          config.rotation.x,
          config.rotation.y,
          config.rotation.z
        );

        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        loadedModels[modelKey] = model;
        resolve(model);
      },
      () => {},
      (error) => {
        console.warn(`Could not load 3D model "${config.file}". Using a fallback where available.`, error);
        resolve(null);
      }
    );
  });
}

async function loadAllRealisticModels() {
  const modelKeys = Object.keys(REALISTIC_MODELS);
  const loadPromises = modelKeys.map((key) => loadModel(key));

  await Promise.all(loadPromises);

  modelsLoaded = true;
  return loadedModels;
}

// ==================== EARTHQUAKE SYSTEM ====================
const quakeTimeline = [];
let activeQuake = null;
let scenarioStartTime = 0;
let totalQuakeDuration = 0;
let coverTimeTotal = 0;
let coverActive = false;
let coverStartTime = 0;
let coverUsed = false;
let scenarioEnded = false;

const cameraShake = {
  pos: new THREE.Vector3(),
  rot: new THREE.Euler(),
};

const physicsObjects = [];
const groundPlaneY = 0;

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function buildQuakeTimeline() {
  quakeTimeline.length = 0;
  totalQuakeDuration = 0;

  const mainStart = 6.0;
  const difficultySettings = {
    practice: { magnitudeMin: 5.2, magnitudeMax: 6.2, durationMin: 8, durationMax: 12, aftershockMin: 1, aftershockMax: 2 },
    standard: { magnitudeMin: 5.9, magnitudeMax: 7.2, durationMin: 12, durationMax: 18, aftershockMin: 2, aftershockMax: 3 },
    intense: { magnitudeMin: 6.6, magnitudeMax: 7.9, durationMin: 16, durationMax: 22, aftershockMin: 3, aftershockMax: 4 },
  };
  const settings = difficultySettings[scenarioDifficulty] || difficultySettings.standard;
  const mainMagnitude = randomRange(settings.magnitudeMin, settings.magnitudeMax);
  const mainDuration = randomRange(settings.durationMin, settings.durationMax);

  quakeTimeline.push({
    start: mainStart,
    magnitude: mainMagnitude,
    duration: mainDuration,
    label: "main",
  });

  totalQuakeDuration += mainDuration;

  const aftershockCount = Math.floor(randomRange(settings.aftershockMin, settings.aftershockMax + 1));
  let nextStart = mainStart + mainDuration + randomRange(4, 8);

  for (let i = 0; i < aftershockCount; i += 1) {
    const magnitude = Math.max(4.0, mainMagnitude - randomRange(0.8, 1.8));
    const duration = randomRange(4, 10);

    quakeTimeline.push({
      start: nextStart,
      magnitude,
      duration,
      label: "aftershock",
    });

    totalQuakeDuration += duration;
    nextStart += duration + randomRange(6, 12);
  }

  responseScoreOpportunity = Math.max(30, quakeTimeline.length * 30);
}

function getMagnitudeScale(magnitude) {
  const normalized = (magnitude - 4.0) / 4.0;
  const scaled = normalized * 1.1 + 0.15;
  return THREE.MathUtils.clamp(scaled, 0.3, 1.1);
}

function startQuake(event) {
  const pulseCount = Math.max(3, Math.min(8, Math.round(event.duration / 2.8)));
  const pulseSpacing = event.duration / pulseCount;
  const pulses = Array.from({ length: pulseCount }, (_, index) => {
    const nominalCenter = pulseSpacing * (index + 0.5);
    const center = THREE.MathUtils.clamp(
      nominalCenter + randomRange(-pulseSpacing * 0.22, pulseSpacing * 0.22),
      0.45,
      event.duration - 0.35
    );
    return {
      center,
      width: randomRange(event.label === "main" ? 0.42 : 0.34, event.label === "main" ? 1.0 : 0.78),
      strength: randomRange(event.label === "main" ? 0.62 : 0.42, 1.0),
    };
  }).sort((a, b) => a.center - b.center);

  activeQuake = {
    start: event.start,
    duration: event.duration,
    magnitude: event.magnitude,
    label: event.label,
    phase: Math.random() * Math.PI * 2,
    waveFrequency: randomRange(0.8, 1.8),
    waveSpeed: randomRange(1.5, 3.5),
    pulses,
    coverScored: false,
  };

  logDecision(
    event.label === "aftershock" ? "aftershock_started" : "quake_started",
    `${event.label === "aftershock" ? "Aftershock" : "Main earthquake"} started (M${event.magnitude.toFixed(
      1
    )}, ${event.duration.toFixed(0)} s)`
  );

  if (coverActive) {
    awardCoverPoints(0);
  }
}

function endActiveQuake() {
  activeQuake = null;
  stopRumble();
  resetCameraShake();
}

function computeIntensity(quake, elapsed) {
  const timeLeft = quake.duration - elapsed;
  const rampProgress = THREE.MathUtils.clamp(elapsed / 1.25, 0, 1);
  const fadeProgress = THREE.MathUtils.clamp(timeLeft / 2.0, 0, 1);
  const ramp = rampProgress * rampProgress * (3 - 2 * rampProgress);
  const fade = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);

  // A sequence of irregular pulses gives the main shock and aftershocks a less uniform feel.
  let pulseEnvelope = 0;
  for (const pulse of quake.pulses) {
    const distance = (elapsed - pulse.center) / pulse.width;
    const pulseValue = pulse.strength * Math.exp(-0.5 * distance * distance);
    pulseEnvelope = Math.max(pulseEnvelope, pulseValue);
  }

  const carrier = 0.68 + 0.32 * Math.sin(elapsed * quake.waveFrequency * Math.PI * 2 + quake.phase);
  const tremor = 0.93 + 0.07 * Math.sin(elapsed * quake.waveSpeed + quake.phase * 1.4);
  const pulseDrive = 0.28 + 0.72 * pulseEnvelope;
  const intensity = ramp * fade * pulseDrive * carrier * tremor * getMagnitudeScale(quake.magnitude);
  return THREE.MathUtils.clamp(intensity, 0, 1.1);
}

function updateEarthquake(delta) {
  if (scenarioEnded) return;
  const frameDelta = Math.min(Math.max(delta, 0), 0.05);

  const scenarioElapsed = (Date.now() - scenarioStartTime) / 1000;

  if (!activeQuake) {
    const nextEvent = quakeTimeline[0];
    if (nextEvent && scenarioElapsed >= nextEvent.start) {
      startQuake(nextEvent);
      quakeTimeline.shift();
    }
  }

  if (activeQuake) {
    const quakeElapsed = scenarioElapsed - activeQuake.start;

    if (quakeElapsed >= activeQuake.duration) {
      endActiveQuake();
      return;
    }

    const intensity = computeIntensity(activeQuake, quakeElapsed);
    const coverMultiplier = coverActive ? 0.45 : 1.0;
    const effectiveIntensity = intensity * coverMultiplier;

    applyCameraShake(effectiveIntensity, scenarioElapsed);
    applyObjectShake(intensity, scenarioElapsed, frameDelta);
    updateAtmosphere(intensity, frameDelta, scenarioElapsed);
    updateRumble(intensity);

    if (coverActive) {
      coverTimeTotal += frameDelta;
    }
  } else {
    relaxObjects(delta);
    updateAtmosphere(0, frameDelta, scenarioElapsed);
  }

  updateCoverState();

  if (timerStarted && !activeQuake && quakeTimeline.length === 0) {
    if (!awaitingExit) {
      awaitingExit = true;
      coverActive = false;
      coverTarget = null;
      if (renderer && renderer.xr.isPresenting && playerRig) playerRig.position.y = 0;
      else if (camera) camera.position.y = EYE_HEIGHT;
      showMessage("Shaking has stopped. Check for hazards, then use the exit when safe.", 5000);
      logDecision("exit_instruction", "Exit guidance shown after shaking stopped");
    }

    if (getPlayerWorldPosition().z > 3.0) {
      const scanComplete = decisionLog.some((entry) => entry.action === "hazard_scan_complete");
      if (!scanComplete) {
        if (!exitPromptedWithoutScan) {
          exitPromptedWithoutScan = true;
          showMessage("Complete the hazard scan before leaving the room.", 2500);
        }
      } else {
        exitCompleted = true;
        endScenario("success");
      }
    }
  }
}

function resetCameraShake() {
  if (!camera) return;
  camera.position.sub(cameraShake.pos);
  camera.rotation.x -= cameraShake.rot.x;
  camera.rotation.y -= cameraShake.rot.y;
  camera.rotation.z -= cameraShake.rot.z;
  cameraShake.pos.set(0, 0, 0);
  cameraShake.rot.set(0, 0, 0);
}

function applyCameraShake(intensity, time) {
  if (!camera) return;
  if (renderer && renderer.xr.isPresenting) return;

  camera.position.sub(cameraShake.pos);
  camera.rotation.x -= cameraShake.rot.x;
  camera.rotation.y -= cameraShake.rot.y;
  camera.rotation.z -= cameraShake.rot.z;

  const baseAmount = 0.025 + intensity * 0.05;
  cameraShake.pos.set(
    Math.sin(time * 12.0) * baseAmount,
    Math.sin(time * 18.0) * baseAmount * 0.6,
    Math.cos(time * 10.0) * baseAmount
  );
  cameraShake.rot.set(
    Math.sin(time * 8.0) * 0.008 * intensity,
    Math.cos(time * 6.0) * 0.007 * intensity,
    Math.sin(time * 9.0) * 0.006 * intensity
  );

  camera.position.add(cameraShake.pos);
  camera.rotation.x += cameraShake.rot.x;
  camera.rotation.y += cameraShake.rot.y;
  camera.rotation.z += cameraShake.rot.z;
}

const PHYSICS_PROFILES = {
  generic: {
    shakePositionScale: 1,
    shakeRotationScale: 1,
    verticalShakeScale: 1,
    toppleThreshold: 0.48,
    toppleRateBase: 0.04,
    toppleRateScale: 0.55,
    lateralImpulse: 0.8,
    spinImpulse: 1.4,
    gravity: 9.81,
    airDrag: 0.18,
    airRotationDrag: 0.12,
    rebound: 0.06,
    maxRebound: 0.45,
    groundFriction: 4.2,
    groundRotationFriction: 5.0,
    linearSettleSq: 0.0025,
    angularSettleSq: 0.012,
    settleDuration: 0.22,
    dustScale: 1,
    impactSoundScale: 1,
  },
  desk: {
    shakePositionScale: 0.42, shakeRotationScale: 0.35, verticalShakeScale: 0.3,
    toppleThreshold: 2, toppleRateBase: 0, toppleRateScale: 0,
    lateralImpulse: 0.2, spinImpulse: 0.2, gravity: 9.81, airDrag: 0.25, airRotationDrag: 0.2,
    rebound: 0, maxRebound: 0, groundFriction: 7, groundRotationFriction: 7,
    linearSettleSq: 0.0025, angularSettleSq: 0.012, settleDuration: 0.22,
    dustScale: 0.3, impactSoundScale: 0.35,
  },
  monitor: {
    shakePositionScale: 0.72, shakeRotationScale: 1.25, verticalShakeScale: 0.55,
    toppleThreshold: 0.42, toppleRateBase: 0.035, toppleRateScale: 0.52,
    lateralImpulse: 0.55, spinImpulse: 1.35, gravity: 9.81, airDrag: 0.22, airRotationDrag: 0.1,
    rebound: 0.045, maxRebound: 0.38, groundFriction: 4.6, groundRotationFriction: 5.8,
    linearSettleSq: 0.0025, angularSettleSq: 0.011, settleDuration: 0.22,
    dustScale: 0.8, impactSoundScale: 0.95,
  },
  smallItem: {
    shakePositionScale: 1.85, shakeRotationScale: 1.3, verticalShakeScale: 0.8,
    toppleThreshold: 0.2, toppleRateBase: 0.13, toppleRateScale: 0.78,
    lateralImpulse: 1.45, spinImpulse: 2.1, gravity: 9.81, airDrag: 0.12, airRotationDrag: 0.08,
    rebound: 0.11, maxRebound: 0.34, groundFriction: 2.8, groundRotationFriction: 3.8,
    linearSettleSq: 0.004, angularSettleSq: 0.018, settleDuration: 0.16,
    dustScale: 0.38, impactSoundScale: 0.32,
  },
  officeChair: {
    shakePositionScale: 0.62, shakeRotationScale: 1.45, verticalShakeScale: 0.35,
    toppleThreshold: 0.4, toppleRateBase: 0.02, toppleRateScale: 0.38,
    lateralImpulse: 1.0, spinImpulse: 1.6, gravity: 9.81, airDrag: 0.2, airRotationDrag: 0.11,
    rebound: 0.02, maxRebound: 0.22, groundFriction: 5.8, groundRotationFriction: 4.3,
    linearSettleSq: 0.003, angularSettleSq: 0.015, settleDuration: 0.3,
    dustScale: 0.72, impactSoundScale: 1.0,
  },
  guestChair: {
    shakePositionScale: 0.58, shakeRotationScale: 1.15, verticalShakeScale: 0.3,
    toppleThreshold: 0.4, toppleRateBase: 0.018, toppleRateScale: 0.34,
    lateralImpulse: 0.72, spinImpulse: 1.25, gravity: 9.81, airDrag: 0.28, airRotationDrag: 0.14,
    rebound: 0.018, maxRebound: 0.18, groundFriction: 6.2, groundRotationFriction: 5.0,
    linearSettleSq: 0.0025, angularSettleSq: 0.012, settleDuration: 0.28,
    dustScale: 0.72, impactSoundScale: 0.9,
  },
  plant: {
    shakePositionScale: 1.1, shakeRotationScale: 1.6, verticalShakeScale: 0.7,
    toppleThreshold: 0.25, toppleRateBase: 0.07, toppleRateScale: 0.7,
    lateralImpulse: 0.78, spinImpulse: 1.1, gravity: 9.81, airDrag: 0.25, airRotationDrag: 0.16,
    rebound: 0.012, maxRebound: 0.14, groundFriction: 3.8, groundRotationFriction: 4.2,
    linearSettleSq: 0.003, angularSettleSq: 0.015, settleDuration: 0.24,
    dustScale: 1.25, impactSoundScale: 0.72,
  },
  heater: {
    shakePositionScale: 0.4, shakeRotationScale: 0.55, verticalShakeScale: 0.25,
    toppleThreshold: 0.65, toppleRateBase: 0.008, toppleRateScale: 0.16,
    lateralImpulse: 0.38, spinImpulse: 0.62, gravity: 9.81, airDrag: 0.35, airRotationDrag: 0.2,
    rebound: 0.008, maxRebound: 0.08, groundFriction: 7.0, groundRotationFriction: 6.5,
    linearSettleSq: 0.002, angularSettleSq: 0.01, settleDuration: 0.32,
    dustScale: 0.5, impactSoundScale: 0.7,
  },
};

function createCenteredPhysicsPivot(object, label = "PhysicsObject") {
  if (!object || !object.parent || object.userData?.isPhysicsPivot) return object;

  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) return object;

  const worldCenter = bounds.getCenter(new THREE.Vector3());
  const parent = object.parent;
  parent.updateWorldMatrix(true, false);
  const localCenter = parent.worldToLocal(worldCenter.clone());

  const pivot = new THREE.Group();
  pivot.name = object.name || label;
  pivot.position.copy(localCenter);
  pivot.userData.isPhysicsPivot = true;
  parent.add(pivot);
  pivot.attach(object);
  return pivot;
}

function registerPhysicsObject(object, options = {}) {
  if (!object) return;

  // Center the moving root on the visual bounds so the asset tips around its body,
  // not around an arbitrary import origin. Object3D.attach preserves its world pose.
  const physicsRoot = createCenteredPhysicsPivot(object, options.label || object.name);
  const box = new THREE.Box3().setFromObject(physicsRoot);
  const basePosition = physicsRoot.position.clone();
  const baseRotation = physicsRoot.rotation.clone();
  const baseMinOffset = basePosition.y - box.min.y;

  physicsRoot.userData.physics = {
    mass: options.mass ?? 5,
    stability: options.stability ?? 0.6,
    allowTopple: options.allowTopple ?? true,
    label: options.label ?? object.name ?? "Object",
    profileName: options.profile ?? "generic",
    motionProfile: PHYSICS_PROFILES[options.profile ?? "generic"] ?? PHYSICS_PROFILES.generic,
    basePosition,
    baseRotation,
    baseMinOffset,
    velocity: new THREE.Vector3(),
    rotationVelocity: new THREE.Vector3(),
    shakeOffset: new THREE.Vector3(),
    shakeRotation: new THREE.Euler(),
    damaged: 0,
    broken: false,
    toppled: false,
    grounded: false,
    settled: false,
    impactPlayed: false,
    bounceCount: 0,
    settleTimer: 0,
    toppleAge: 0,
    seed: Math.random() * Math.PI * 2,
  };

  physicsObjects.push(physicsRoot);
}

function applyObjectShake(intensity, time, delta) {
  physicsObjects.forEach((object) => {
    const data = object.userData.physics;
    if (!data || (data.toppled && data.settled)) return;
    const profile = data.motionProfile;

    object.position.sub(data.shakeOffset);
    object.rotation.x -= data.shakeRotation.x;
    object.rotation.y -= data.shakeRotation.y;
    object.rotation.z -= data.shakeRotation.z;

    if (data.toppled) {
      data.shakeOffset.set(0, 0, 0);
      data.shakeRotation.set(0, 0, 0);
      updateToppledObject(object, data, delta);
      return;
    }

    const massFactor = 1 / Math.sqrt(Math.max(1.0, data.mass));
    const shakeStrength = intensity * massFactor * 2.1;
    const t = time + data.seed;
    const movementScale = profile.shakePositionScale;

    data.shakeOffset.set(
      Math.sin(t * 7.0) * 0.03 * shakeStrength * movementScale,
      Math.sin(t * 11.0) * 0.02 * shakeStrength * movementScale * profile.verticalShakeScale,
      Math.cos(t * 9.0) * 0.03 * shakeStrength * movementScale
    );
    data.shakeRotation.set(
      Math.sin(t * 6.0) * 0.03 * shakeStrength * profile.shakeRotationScale,
      Math.cos(t * 5.0) * 0.02 * shakeStrength * profile.shakeRotationScale,
      Math.sin(t * 8.0) * 0.03 * shakeStrength * profile.shakeRotationScale
    );

    object.position.add(data.shakeOffset);
    object.rotation.x += data.shakeRotation.x;
    object.rotation.y += data.shakeRotation.y;
    object.rotation.z += data.shakeRotation.z;

    const toppleRisk = intensity * (1 - data.stability);
    // Convert chance to a rate so toppling is less dependent on display frame rate.
    const toppleRate = profile.toppleRateBase + toppleRisk * profile.toppleRateScale;
    const toppleChance = 1 - Math.exp(-toppleRate * Math.min(Math.max(delta, 0), 0.05));
    if (
      data.allowTopple &&
      toppleRisk > profile.toppleThreshold &&
      Math.random() < toppleChance
    ) {
      data.toppled = true;
      data.velocity.set(
        (Math.random() - 0.5) * profile.lateralImpulse * (0.7 + intensity),
        0,
        (Math.random() - 0.5) * profile.lateralImpulse * (0.7 + intensity)
      );
      // Items tumble more; larger furniture usually tips with a slower rotation.
      data.rotationVelocity.set(
        (Math.random() - 0.35) * profile.spinImpulse * (0.8 + intensity),
        (Math.random() - 0.5) * profile.spinImpulse * 0.45,
        (Math.random() - 0.35) * profile.spinImpulse * (0.8 + intensity)
      );
      data.grounded = false;
      data.settled = false;
      data.impactPlayed = false;
      data.bounceCount = 0;
      data.settleTimer = 0;
      createDustBurst(object.position, Math.min(0.65, intensity * 0.35 * profile.dustScale));
      logDecision("object_toppled", `${data.label} toppled`);
    }

    applyDamage(object, data, intensity, delta);
  });
}

function updateToppledObject(object, data, delta) {
  if (data.settled) return;

  // Clamp frame time after tab stalls so a single long frame cannot launch objects
  // through the floor. This is a lightweight game approximation, not rigid-body physics.
  const dt = Math.min(Math.max(delta, 0), 0.05);
  const profile = data.motionProfile;
  data.toppleAge += dt;
  data.velocity.y -= profile.gravity * dt;
  data.velocity.x *= Math.exp(-profile.airDrag * dt);
  data.velocity.z *= Math.exp(-profile.airDrag * dt);
  object.position.addScaledVector(data.velocity, dt);

  const airRotationDamping = Math.exp(-profile.airRotationDrag * dt);
  object.rotation.x += data.rotationVelocity.x * dt;
  object.rotation.y += data.rotationVelocity.y * dt;
  object.rotation.z += data.rotationVelocity.z * dt;
  data.rotationVelocity.multiplyScalar(airRotationDamping);

  toppledBounds.setFromObject(object);
  if (toppledBounds.min.y <= groundPlaneY) {
    const impactSpeed = Math.max(0, -data.velocity.y);
    object.position.y += groundPlaneY - toppledBounds.min.y;

    if (!data.impactPlayed) {
      data.impactPlayed = true;
      const impactStrength = THREE.MathUtils.clamp(impactSpeed / 7.5, 0.2, 1.0);
      const impactPosition = new THREE.Vector3(
        object.position.x,
        groundPlaneY + 0.02,
        object.position.z
      );
      createDustBurst(impactPosition, impactStrength * profile.dustScale);
      playImpactSound(impactStrength * profile.impactSoundScale);
      logDecision("object_impact", data.label + " hit the floor");
    }

    // A single small rebound makes impacts readable without allowing endless bouncing.
    if (data.bounceCount === 0 && impactSpeed > 1.6 && profile.rebound > 0) {
      data.velocity.y = Math.min(profile.maxRebound, impactSpeed * profile.rebound);
      data.bounceCount += 1;
      data.grounded = false;
    } else {
      data.velocity.y = 0;
      data.grounded = true;
    }
  } else {
    data.grounded = false;
  }

  if (data.grounded) {
    const horizontalDamping = Math.exp(-profile.groundFriction * dt);
    const rotationDamping = Math.exp(-profile.groundRotationFriction * dt);
    data.velocity.x *= horizontalDamping;
    data.velocity.z *= horizontalDamping;
    data.rotationVelocity.multiplyScalar(rotationDamping);

    const horizontalSpeedSq =
      data.velocity.x * data.velocity.x + data.velocity.z * data.velocity.z;
    const angularSpeedSq =
      data.rotationVelocity.x * data.rotationVelocity.x +
      data.rotationVelocity.y * data.rotationVelocity.y +
      data.rotationVelocity.z * data.rotationVelocity.z;

    if (horizontalSpeedSq < profile.linearSettleSq && angularSpeedSq < profile.angularSettleSq) {
      data.settleTimer += dt;
      if (data.settleTimer >= profile.settleDuration) {
        data.velocity.set(0, 0, 0);
        data.rotationVelocity.set(0, 0, 0);
        data.settled = true;
        logDecision("object_settled", data.label + " came to rest");
      }
    } else {
      data.settleTimer = 0;
    }
  } else {
    data.settleTimer = 0;
  }
}

function relaxObjects(delta) {
  physicsObjects.forEach((object) => {
    const data = object.userData.physics;
    if (!data) return;

    if (data.toppled) {
      updateToppledObject(object, data, delta);
      return;
    }

    const dt = Math.min(Math.max(delta, 0), 0.1);
    const recoveryAlpha = 1 - Math.exp(-2.5 * dt);
    object.position.lerp(data.basePosition, recoveryAlpha);
    object.rotation.x = THREE.MathUtils.lerp(
      object.rotation.x,
      data.baseRotation.x,
      recoveryAlpha
    );
    object.rotation.y = THREE.MathUtils.lerp(
      object.rotation.y,
      data.baseRotation.y,
      recoveryAlpha
    );
    object.rotation.z = THREE.MathUtils.lerp(
      object.rotation.z,
      data.baseRotation.z,
      recoveryAlpha
    );
  });
}

function applyDamage(object, data, intensity, delta) {
  if (intensity < 0.55 || data.broken) return;

  // Damage accumulation is time-based, not one random roll per rendered frame.
  const damageRate = intensity * (1 - data.stability) * 0.85;
  const chance = 1 - Math.exp(-damageRate * Math.min(Math.max(delta, 0), 0.05));
  if (Math.random() < chance) {
    data.damaged = Math.min(1, data.damaged + intensity * 0.15);

    if (data.damaged > 0.6 && !data.broken) {
      data.broken = true;
      markObjectDamaged(object);
      logDecision("object_damaged", `${data.label} was damaged`);
    }
  }
}

function markObjectDamaged(object) {
  object.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    // Clone before tinting so a shared GLB material doesn't darken other objects.
    if (Array.isArray(child.material)) {
      child.material = child.material.map((material) => material.clone());
    } else {
      child.material = child.material.clone();
    }
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      if (!mat.color) return;
      mat.color.offsetHSL(0, 0, -0.25);
      if (mat.emissive) {
        mat.emissive.offsetHSL(0, 0, -0.15);
      }
    });
  });
}

function updateCoverState() {
  if (!shelterZone) return;
  const inZone = isCameraInShelter();

  if (!inZone && coverActive) {
    coverActive = false;
    coverTarget = null;
    if (renderer && renderer.xr.isPresenting && playerRig) playerRig.position.y = 0;
    else if (camera) camera.position.y = EYE_HEIGHT;
    showMessage("You left the cover area.", 1000);
  }
}

function isCameraInShelter() {
  if (!shelterZone) return false;
  shelterZone.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(shelterZone);
  if (!box.containsPoint(getPlayerWorldPosition())) return false;
  const reason = getNoCoverReason();
  return !reason;
}

function getNoCoverReason() {
  const playerPosition = getPlayerWorldPosition();
  for (const zone of noCoverZones) {
    if (zone.box.containsPoint(playerPosition)) {
      return zone.label;
    }
  }
  return "";
}

function takeCover() {
  const noCoverReason = getNoCoverReason();
  if (noCoverReason) {
    showMessage(`${noCoverReason} is not a safe cover location.`, 2000);
    return;
  }

  if (!shelterZone || !isCameraInShelter()) {
    showMessage("Move into the designated cover area first.", 1500);
    return;
  }

  if (!coverActive) {
    coverActive = true;
    coverStartTime = Date.now();
    coverUsed = true;
    if (renderer && renderer.xr.isPresenting) {
      coverTarget = playerRig.position.clone();
      playerRig.position.y = -0.55;
    } else {
      coverTarget = new THREE.Vector3(
        camera.position.x,
        EYE_HEIGHT_CROUCH,
        camera.position.z
      );
      camera.position.y = EYE_HEIGHT_CROUCH;
    }

    if (activeQuake && !activeQuake.coverScored) {
      const responseTime = (Date.now() - scenarioStartTime) / 1000 - activeQuake.start;
      awardCoverPoints(Math.max(0, responseTime));
    }

    logDecision("took_cover", "Took cover in the designated area");
    showMessage("Cover position taken.", 1500);
  }
}

function awardCoverPoints(responseTime) {
  if (!activeQuake || activeQuake.coverScored) return;

  activeQuake.coverScored = true;

  const points = responseTime < 2 ? 30 : responseTime < 5 ? 20 : 10;
  coverResponseRawScore += points;
  coverResponseScore = Math.round(Math.min(1, coverResponseRawScore / responseScoreOpportunity) * 120);
  userScore = coverResponseScore;
}

// ==================== TIMING AND SCORING ====================
let timerStarted = false;
let startTime = 0;
let userScore = 0;
let coverResponseScore = 0;
let coverResponseRawScore = 0;
let responseScoreOpportunity = 120;
let coverDurationScore = 0;
let decisionLog = [];
let postKnowledgeScore = null;
let lastScenarioReport = null;

function logDecision(action, description) {
  decisionLog.push({
    time: Date.now() - startTime,
    action,
    description,
  });
}

function showMessage(message, duration = 4000) {
  const messageDiv = document.getElementById("messageBox");
  if (!messageDiv) return;

  if (messageTimeoutId !== null) clearTimeout(messageTimeoutId);
  messageDiv.textContent = message;
  messageDiv.style.display = "block";

  messageTimeoutId = setTimeout(() => {
    messageDiv.style.display = "none";
    messageTimeoutId = null;
  }, duration);
}

function updateStatus() {
  const statusDiv = document.getElementById("quakeStatus");
  if (!statusDiv) return;

  if (!timerStarted) {
    statusDiv.textContent = "Earthquake status: Waiting";
    statusDiv.style.color = "#ffff00";
    statusDiv.style.animation = "none";
    return;
  }

  if (awaitingExit) {
    statusDiv.textContent = "Shaking has stopped. Check for hazards, then use the exit when safe.";
    statusDiv.style.color = "#00ff99";
    statusDiv.style.borderColor = "#00ff99";
    statusDiv.style.animation = "none";
  } else if (activeQuake) {
    const label = activeQuake.label === "aftershock" ? "AFTERSHOCK" : "MAIN QUAKE";
    statusDiv.textContent = `${label}! M${activeQuake.magnitude.toFixed(
      1
    )} - Cover: ${coverActive ? "YES" : "NO"}`;
    statusDiv.style.color = "#ff8800";
    statusDiv.style.borderColor = "#ff8800";
    statusDiv.style.animation = "pulse 0.5s infinite";
  } else if (quakeTimeline.length > 0) {
    const elapsed = timerStarted ? (Date.now() - scenarioStartTime) / 1000 : 0;
    const mainQuakeHasStarted = decisionLog.some((entry) => entry.action === "quake_started");
    if (!mainQuakeHasStarted && elapsed < quakeTimeline[0].start) {
      const secondsUntilQuake = Math.max(1, Math.ceil(quakeTimeline[0].start - elapsed));
      statusDiv.textContent = "Get ready: earthquake begins in " + secondsUntilQuake + " s. Locate cover.";
      statusDiv.style.color = "#00d4ff";
      statusDiv.style.borderColor = "#00d4ff";
    } else {
      statusDiv.textContent = "Shaking has paused; stay alert for possible aftershocks.";
      statusDiv.style.color = "#00d4ff";
      statusDiv.style.borderColor = "#00d4ff";
    }
    statusDiv.style.animation = "none";
  } else {
    statusDiv.textContent = "The simulated shaking has ended. Check for hazards before exiting.";
    statusDiv.style.color = "#00ff00";
    statusDiv.style.borderColor = "#00ff00";
    statusDiv.style.animation = "none";
  }
}

function endScenario(result) {
  if (scenarioEnded) return;

  scenarioEnded = true;
  timerStarted = false;
  awaitingExit = false;

  const timerDiv = document.getElementById("timer");
  if (timerDiv) timerDiv.style.display = "none";

  resetCameraShake();
  stopRumble();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const coverRatio = totalQuakeDuration > 0 ? coverTimeTotal / totalQuakeDuration : 0;
  coverDurationScore = Math.round(Math.min(1, coverRatio) * 60);
  userScore = Math.min(180, coverResponseScore + coverDurationScore);

  const toppledCount = physicsObjects.filter(
    (obj) => obj.userData.physics && obj.userData.physics.toppled
  ).length;
  const damagedCount = physicsObjects.filter(
    (obj) => obj.userData.physics && obj.userData.physics.broken
  ).length;

  const resultDiv = document.getElementById("resultScreen");
  const resultTitle = document.getElementById("resultTitle");
  const resultText = document.getElementById("resultText");
  const scoreText = document.getElementById("scoreText");
  const timeText = document.getElementById("timeText");
  const logText = document.getElementById("decisionLog");

  if (!resultDiv) return;

  resultDiv.style.display = "block";

  let title = "";
  let text = "";
  let color = "";

  if (result === "success" && coverUsed) {
    title = "Well done — you completed the earthquake scenario";
    text =
      "You took cover in the designated area and waited until the simulated aftershocks ended.";
    color = "#00ff00";
  } else if (result === "success" && !coverUsed) {
    title = "Scenario complete, but no cover was taken";
    text =
      "The scenario ended without you taking cover, so it was not scored as a safe completion.";
    color = "#ffaa00";
  } else {
    title = "Scenario Complete";
    text = "The simulated shaking has ended.";
    color = "#00ff00";
  }

  resultTitle.textContent = title;
  resultTitle.style.color = color;
  resultText.textContent = text;
  scoreText.textContent = `Total score: ${userScore} / 180`;
  const scoreBreakdown = document.getElementById("scoreBreakdown");
  if (scoreBreakdown) scoreBreakdown.textContent = `Response to shaking: ${coverResponseScore} / 120 · Time protected: ${coverDurationScore} / 60`;
  timeText.textContent = `Total time: ${totalTime} seconds`;

  let logHTML = "<h4>Decision Log:</h4><ul>";
  decisionLog.forEach((log) => {
    logHTML += `<li>[${(log.time / 1000).toFixed(1)}s] ${log.description}</li>`;
  });
  logHTML += `</ul><p>Objects toppled: ${toppledCount} | Objects damaged: ${damagedCount}</p>`;
  logText.innerHTML = logHTML;

  if (controls) controls.unlock();
  const objectivePanel = document.getElementById("objectivePanel");
  if (objectivePanel) objectivePanel.style.display = "none";
  const hazardScanResult = document.getElementById("hazardScanResult");
  if (hazardScanResult) hazardScanResult.textContent = "";

  lastScenarioReport = {
    totalTime,
    score: userScore,
    coverResponseScore,
    coverDurationScore,
    resultText: title + " - " + text,
    toppledCount,
    damagedCount,
  };

  const reportButton = document.getElementById("downloadReportBtn");
  if (reportButton) reportButton.disabled = false;
  if (renderer && renderer.xr.isPresenting) updateXRWelcomePanel();
}

function exportToCSV(totalTime, score, resultText, toppledCount, damagedCount) {
  const user = window.userData || {
    name: "Unknown",
    surname: "User",
    startTime: new Date().toLocaleString("en-GB"),
  };

  function csvCell(value) {
    const raw = String(value ?? "").replace(/\r?\n/g, " ");
    const safe = /^[=+\-@]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replace(/"/g, '""') + '"';
  }

  function formatElapsedTime(seconds) {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const totalSecondsInt = Math.floor(safeSeconds);
    const tenths = Math.floor((safeSeconds - totalSecondsInt) * 10 + 1e-9);
    const mins = Math.floor(totalSecondsInt / 60);
    const secs = totalSecondsInt % 60;
    return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0") + "." + tenths;
  }

  let csvContent = "\uFEFF";
  csvContent += "EARTHQUAKE TRAINING SIMULATION REPORT\n";
  csvContent += "--------------------------------\n";
  csvContent += csvCell("Name") + ";" + csvCell(user.name + " " + user.surname) + "\n";
  csvContent += csvCell("Date") + ";" + csvCell(user.startTime) + "\n";
  csvContent += csvCell("Total time") + ";" + csvCell(totalTime + " seconds") + "\n";
  csvContent += csvCell("Score") + ";" + csvCell(score) + "\n";
  csvContent += csvCell("Response to shaking") + ";" + csvCell(coverResponseScore + " / 120") + "\n";
  csvContent += csvCell("Time protected") + ";" + csvCell(coverDurationScore + " / 60") + "\n";
  csvContent += csvCell("Objects toppled") + ";" + csvCell(toppledCount) + "\n";
  csvContent += csvCell("Objects damaged") + ";" + csvCell(damagedCount) + "\n";
  csvContent += csvCell("Result") + ";" + csvCell(resultText) + "\n\n";
  csvContent += "--------------------------------\n";
  csvContent += "DETAILED DECISION LOG\n";
  csvContent += "Time (mm:ss.s);Action;Description\n";

  decisionLog.forEach((log) => {
    const timeSeconds = typeof log.time === "number" ? log.time / 1000 : Number(log.time);
    const time = "'" + formatElapsedTime(timeSeconds);
    csvContent += csvCell(time) + ";" + csvCell(log.action) + ";" + csvCell(log.description) + "\n";
  });

  csvContent += csvCell("Knowledge check score") + ";" +
    csvCell(postKnowledgeScore === null ? "Not completed" : postKnowledgeScore + "/3") + "\n";

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeFilename = (value) => String(value || "User")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_");
  link.setAttribute("href", url);
  link.setAttribute("download", "Earthquake_Training_Report_" + safeFilename(user.name) + "_" +
    safeFilename(user.surname) + "_" + dateStr + ".csv");
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------- GUI ------------------------

const guiObject = {
  pauseBoolean: false,
  value3: 1.55,
  value4: 0.05,
  color: { r: 0.01, g: 0.01, b: 0.01 },
};

function addGUI() {
  if (!guiEnable) return;

  gui = new GUI();
  guiCam = gui.addFolder("QuakeSim");
  guiCam.add(guiObject, "value3", 0, 10).name("Scene Brightness");
  guiCam.addColor(guiObject, "color", 255).name("Floor Color");
  guiCam.add(guiObject, "pauseBoolean").name("Pause");
}

addGUI();
initApp();

async function initApp() {
  try {
    await init();
    createProceduralHands();
    renderer.setAnimationLoop(animate);
  } catch (error) {
    console.error("Earthquake Awareness Simulator failed to initialize.", error);
    const panel = document.createElement("section");
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;inset:1rem;z-index:10000;max-width:42rem;margin:auto;padding:1.5rem;background:#1a1a2e;color:#fff;border:2px solid #ff8a65;border-radius:12px;font:16px/1.5 Arial,sans-serif;overflow:auto;";
    const heading = document.createElement("h2");
    heading.textContent = "The simulation could not start";
    const message = document.createElement("p");
    message.textContent = "The 3D scene failed to initialize. Refresh the page and check the browser console if the problem continues.";
    const detail = document.createElement("pre");
    detail.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;color:#ffccbc;";
    detail.textContent = error instanceof Error ? error.message : String(error);
    panel.append(heading, message, detail);
    document.body.appendChild(panel);
  }
}

async function init() {
  const container = document.createElement("div");
  document.body.appendChild(container);

  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01,
    100
  );
  camera.position.set(0, 1.6, 2.0);

  scene = new THREE.Scene();
  playerRig = new THREE.Group();
  scene.add(playerRig);
  playerRig.add(camera);

  await createRoom();

  if (ENV_REFLECTION_ENABLED) {
    hdriLoader.load(
      "Env.hdr",
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.environment = texture;
      },
      undefined,
      (error) => console.warn("Could not load the environment HDR image.", error)
    );
  } else {
    scene.environment = null;
  }

  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 8, 20);

  renderer = new THREE.WebGLRenderer({ antialias: antialiasing });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = 1;
  container.appendChild(renderer.domElement);

  // Keep controller interactions in the in-world panels and preserve VRButton's
  // default optional local-floor and bounded-floor features.
  const vrButton = VRButton.createButton(renderer);
  vrButton.id = "webxr-vr-button";
  vrButton.style.left = "auto";
  document.body.appendChild(vrButton);

  renderer.xr.addEventListener("sessionstart", onXRSessionStart);
  renderer.xr.addEventListener("sessionend", onXRSessionEnd);
  createXRInterface();

  for (let index = 0; index < 2; index += 1) {
    const controller = renderer.xr.getController(index);
    controller.addEventListener("select", () => handleXRSelect(controller));
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -3),
      ]),
      new THREE.LineBasicMaterial({ color: 0x00d4ff })
    );
    ray.name = "xr-controller-ray";
    controller.add(ray);
    scene.add(controller);
    xrControllers.push(controller);
  }

  controls = new PointerLockControls(camera, document.body);

  controls.addEventListener("lock", function () {
    isLocked = true;
  });

  controls.addEventListener("unlock", function () {
    isLocked = false;
    moveState.forward = false;
    moveState.backward = false;
    moveState.left = false;
    moveState.right = false;
  });

  let visibilityPauseStart = null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !(renderer && renderer.xr.isPresenting)) {
      if (visibilityPauseStart === null) visibilityPauseStart = Date.now();
      moveState.forward = false;
      moveState.backward = false;
      moveState.left = false;
      moveState.right = false;
      stopRumble();
      resetCameraShake();
    } else if (!document.hidden && visibilityPauseStart !== null) {
      const pausedFor = Date.now() - visibilityPauseStart;
      if (timerStarted && !scenarioEnded) {
        scenarioStartTime += pausedFor;
        startTime += pausedFor;
      }
      visibilityPauseStart = null;
    }
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    moveState.forward = false;
    moveState.backward = false;
    moveState.left = false;
    moveState.right = false;
  });

  window.addEventListener("resize", onWindowResize);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
  ambientLightRef = ambientLight;
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0xe8f4fc, 0x8b7355, 0.5);
  hemiLightRef = hemiLight;
  scene.add(hemiLight);

  const ceilingLight1 = new THREE.PointLight(0xffffee, 2.0, 10);
  ceilingLights = [ceilingLight1];
  ceilingLight1.position.set(-1, 2.8, -1);
  ceilingLight1.castShadow = true;
  scene.add(ceilingLight1);

  const ceilingLight2 = new THREE.PointLight(0xffffee, 2.0, 10);
  ceilingLights.push(ceilingLight2);
  ceilingLight2.position.set(1, 2.8, 1);
  ceilingLight2.castShadow = true;
  scene.add(ceilingLight2);

  const fillDir = new THREE.DirectionalLight(0xffffff, 0.8);
  fillDir.position.set(2, 4, 2);
  scene.add(fillDir);
  createDustSystem();

  renderer.shadowMap.enabled = SHADOWS_ENABLED;
  if (SHADOWS_ENABLED) renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.05,
    0.7,
    0.4
  );
  composer.addPass(bloomPass);

  if (AmbientOcclusion) {
    const ssaoPass = new SSAOPass(scene, camera);
    ssaoPass.kernelRadius = 0.01;
    ssaoPass.minDistance = 0.0001;
    ssaoPass.maxDistance = 0.1;
    composer.addPass(ssaoPass);
  }
}

function createXRLabelTexture(label, backgroundColor = "#087f8c") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#8de0ff";
  context.lineWidth = 6;
  context.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  context.fillStyle = "#ffffff";
  context.font = "bold 34px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 24);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createXRPanelButton(name, label, y, backgroundColor) {
  const button = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 0.12),
    new THREE.MeshBasicMaterial({ map: createXRLabelTexture(label, backgroundColor), transparent: false, depthTest: false })
  );
  button.name = name;
  button.position.set(0, y, 0.02);
  button.renderOrder = 20;
  return button;
}

function updateXRWelcomePanel() {
  if (!xrWelcomePanel) return;
  const modeButton = xrWelcomePanel.getObjectByName("xrModeButton");
  const difficultyButton = xrWelcomePanel.getObjectByName("xrDifficultyButton");
  const startButton = xrWelcomePanel.getObjectByName("xrStartButton");
  const exitButton = xrWelcomePanel.getObjectByName("xrExitButton");
  if (scenarioEnded) {
    const context = xrWelcomeCanvas.getContext("2d");
    context.clearRect(0, 0, xrWelcomeCanvas.width, xrWelcomeCanvas.height);
    context.fillStyle = "rgba(5, 12, 26, 0.96)";
    context.fillRect(0, 0, xrWelcomeCanvas.width, xrWelcomeCanvas.height);
    context.strokeStyle = "#00d4ff";
    context.lineWidth = 12;
    context.strokeRect(8, 8, xrWelcomeCanvas.width - 16, xrWelcomeCanvas.height - 16);
    context.textAlign = "center";
    context.fillStyle = "#8de0ff";
    context.font = "bold 60px Arial";
    context.fillText("SCENARIO COMPLETE", 512, 145);
    context.fillStyle = "#ffffff";
    context.font = "32px Arial";
    context.fillText("Exit immersive mode to review your score", 512, 235);
    context.fillText("and open the safety knowledge check.", 512, 285);
    if (xrWelcomeTexture) xrWelcomeTexture.needsUpdate = true;
    if (modeButton) modeButton.visible = false;
    if (difficultyButton) difficultyButton.visible = false;
    if (startButton) startButton.visible = false;
    if (exitButton) exitButton.visible = true;
    return;
  }
  if (modeButton) modeButton.visible = true;
  if (difficultyButton) difficultyButton.visible = true;
  if (startButton) startButton.visible = true;
  if (exitButton) exitButton.visible = false;
  if (modeButton) {
    modeButton.material.map.dispose();
    modeButton.material.map = createXRLabelTexture("Mode: " + (scenarioMode === "guided" ? "Guided" : "Challenge") + " (tap to change)", "#244f7a");
    modeButton.material.needsUpdate = true;
  }
  if (difficultyButton) {
    difficultyButton.material.map.dispose();
    difficultyButton.material.map = createXRLabelTexture("Difficulty: " + scenarioDifficulty + " (tap to cycle)", "#244f7a");
    difficultyButton.material.needsUpdate = true;
  }
}

function createXRInterface() {
  xrWelcomePanel = new THREE.Group();
  xrWelcomePanel.name = "xrWelcomePanel";
  xrWelcomePanel.position.set(0, -0.02, -1.45);
  xrWelcomePanel.visible = false;

  const panelCanvas = document.createElement("canvas");
  panelCanvas.width = 1024;
  panelCanvas.height = 768;
  const context = panelCanvas.getContext("2d");
  context.fillStyle = "rgba(5, 12, 26, 0.96)";
  context.fillRect(0, 0, panelCanvas.width, panelCanvas.height);
  context.strokeStyle = "#00d4ff";
  context.lineWidth = 12;
  context.strokeRect(8, 8, panelCanvas.width - 16, panelCanvas.height - 16);
  context.textAlign = "center";
  context.fillStyle = "#8de0ff";
  context.font = "bold 58px Arial";
  context.fillText("EARTHQUAKE TRAINING", 512, 100);
  context.fillStyle = "#ffffff";
  context.font = "34px Arial";
  context.fillText("First-person safety practice", 512, 165);
  context.font = "28px Arial";
  context.fillText("Point a controller and press its trigger to select.", 512, 230);
  context.fillText("Use the thumbstick to move; take cover under a sturdy desk.", 512, 275);
  xrWelcomeCanvas = panelCanvas;
  const panelTexture = new THREE.CanvasTexture(panelCanvas);
  panelTexture.colorSpace = THREE.SRGBColorSpace;
  xrWelcomeTexture = panelTexture;
  const panelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 1.0),
    new THREE.MeshBasicMaterial({ map: panelTexture, transparent: false, depthTest: false })
  );
  panelMesh.renderOrder = 10;
  xrWelcomePanel.add(panelMesh);
  xrWelcomePanel.add(createXRPanelButton("xrModeButton", "Mode: Guided (tap to change)", -0.16, "#244f7a"));
  xrWelcomePanel.add(createXRPanelButton("xrDifficultyButton", "Difficulty: standard (tap to cycle)", -0.32, "#244f7a"));
  xrWelcomePanel.add(createXRPanelButton("xrStartButton", "START SCENARIO", -0.47, "#087f55"));
  const xrExitButton = createXRPanelButton("xrExitButton", "EXIT VR / REVIEW RESULTS", -0.36, "#087f55");
  xrExitButton.visible = false;
  xrWelcomePanel.add(xrExitButton);
  camera.add(xrWelcomePanel);

  xrHudPanel = new THREE.Group();
  xrHudPanel.name = "xrHudPanel";
  xrHudPanel.position.set(0, -0.48, -1.35);
  xrHudPanel.visible = false;
  xrHudCanvas = document.createElement("canvas");
  xrHudCanvas.width = 1024;
  xrHudCanvas.height = 256;
  xrHudTexture = new THREE.CanvasTexture(xrHudCanvas);
  xrHudTexture.colorSpace = THREE.SRGBColorSpace;
  const hudMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.25, 0.31),
    new THREE.MeshBasicMaterial({ map: xrHudTexture, transparent: true, depthTest: false })
  );
  hudMesh.renderOrder = 15;
  xrHudPanel.add(hudMesh);
  camera.add(xrHudPanel);
}

function updateXRInterface() {
  if (!renderer || !renderer.xr.isPresenting) {
    if (xrWelcomePanel) xrWelcomePanel.visible = false;
    if (xrHudPanel) xrHudPanel.visible = false;
    return;
  }
  const session = renderer.xr.getSession();
  const hasDomOverlay = Boolean(session && session.domOverlayState);
  if (xrWelcomePanel) xrWelcomePanel.visible = !hasDomOverlay && ((!timerStarted && !scenarioEnded) || scenarioEnded);
  if (!xrHudPanel) return;
  xrHudPanel.visible = !hasDomOverlay && timerStarted && !scenarioEnded;
  if (!xrHudPanel.visible) return;

  const statusDiv = document.getElementById("quakeStatus");
  const status = statusDiv ? statusDiv.textContent : "Scenario in progress";
  const objectiveText = "Cover: " + (coverUsed ? "taken" : "not yet") +
    " | Hold: " + (coverTimeTotal >= 3 ? "complete" : "in progress");
  const scanComplete = decisionLog.some((entry) => entry.action === "hazard_scan_complete");
  const scanText = awaitingExit && !scanComplete
    ? "Point into open space and press trigger to scan hazards."
    : "Hazard scan: " + (scanComplete ? "complete" : "pending") + " | Exit: " + (exitCompleted ? "complete" : "pending");
  const textValue = [status, scenarioMode + " mode · " + scenarioDifficulty, objectiveText, scanText].join("\n");
  if (textValue === lastXRHudText) return;
  lastXRHudText = textValue;
  const context = xrHudCanvas.getContext("2d");
  context.clearRect(0, 0, xrHudCanvas.width, xrHudCanvas.height);
  context.fillStyle = "rgba(5, 12, 26, 0.88)";
  context.fillRect(0, 0, xrHudCanvas.width, xrHudCanvas.height);
  context.strokeStyle = "#00d4ff";
  context.lineWidth = 6;
  context.strokeRect(4, 4, xrHudCanvas.width - 8, xrHudCanvas.height - 8);
  context.textAlign = "left";
  context.fillStyle = "#8de0ff";
  context.font = "bold 32px Arial";
  context.fillText(textValue.split("\n")[0].slice(0, 70), 28, 54, 960);
  context.fillStyle = "#ffffff";
  context.font = "26px Arial";
  context.fillText(textValue.split("\n")[1], 28, 108);
  context.fillText(textValue.split("\n")[2], 28, 158);
  context.fillText(textValue.split("\n")[3], 28, 208);
  xrHudTexture.needsUpdate = true;
}

function onXRSessionStart() {
  resetCameraShake();
  if (controls && controls.isLocked) controls.unlock();
  playerRig.position.set(0, 0, 2);
  playerRig.rotation.set(0, 0, 0);
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  moveState.forward = false;
  moveState.backward = false;
  moveState.left = false;
  moveState.right = false;
  lastXRHudText = "";
  updateXRWelcomePanel();
  updateXRInterface();
  showMessage("Use the thumbstick to move. Point a controller and press its trigger to interact.", 5000);
}

function onXRSessionEnd() {
  playerRig.position.set(0, 0, 0);
  playerRig.rotation.set(0, 0, 0);
  camera.position.set(0, EYE_HEIGHT, 2);
  camera.rotation.set(0, 0, 0);
  coverActive = false;
  coverTarget = null;
  if (xrWelcomePanel) xrWelcomePanel.visible = false;
  if (xrHudPanel) xrHudPanel.visible = false;
  lastXRHudText = "";
}

function getPlayerWorldPosition(target = new THREE.Vector3()) {
  if (camera) camera.getWorldPosition(target);
  return target;
}

function updateXRMovement(delta) {
  if (!renderer || !renderer.xr.isPresenting || !playerRig || coverActive) return;
  delta = Math.min(Math.max(delta, 0), 0.05);
  const session = renderer.xr.getSession();
  if (!session) return;

  let axisX = 0;
  let axisY = 0;
  for (const source of session.inputSources) {
    if (!source.gamepad) continue;
    const axes = source.gamepad.axes;
    if (!axes || axes.length < 2) continue;
    const x = axes[0];
    const y = axes[1];
    if (Math.abs(x) > Math.abs(axisX)) axisX = x;
    if (Math.abs(y) > Math.abs(axisY)) axisY = y;
  }

  if (Math.abs(axisX) < 0.15) axisX = 0;
  if (Math.abs(axisY) < 0.15) axisY = 0;
  if (axisX === 0 && axisY === 0) return;

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  direction.y = 0;
  direction.normalize();
  const strafe = new THREE.Vector3().crossVectors(direction, camera.up).normalize();
  const velocity = new THREE.Vector3()
    .addScaledVector(direction, -axisY)
    .addScaledVector(strafe, axisX);

  if (velocity.lengthSq() === 0) return;
  velocity.normalize().multiplyScalar(moveSpeed * delta);
  playerRig.position.add(velocity);
  clampInsideRoom(playerRig.position);
}

function handleXRSelect(controller) {
  if (!room || !renderer || !renderer.xr.isPresenting) return;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromXRController(controller);
  const targets = xrWelcomePanel && xrWelcomePanel.visible ? [room, xrWelcomePanel] : [room];
  const intersections = raycaster.intersectObjects(targets, true);
  const hit = intersections.find((intersection) => {
    if (intersection.distance >= 3.0) return false;
    let candidate = intersection.object;
    while (candidate && candidate !== room) {
      if (["Door", "shelterZone", "desk", "xrModeButton", "xrDifficultyButton", "xrStartButton", "xrExitButton"].includes(candidate.name) || candidate.userData?.physics) return true;
      candidate = candidate.parent;
    }
    return false;
  });
  if (!hit) {
    if (awaitingExit) {
      scanVisibleHazards();
    } else {
      showMessage("Point at the desk to take cover, or at the door to open it.", 1800);
    }
    return;
  }

  if (hit.object.name === "xrExitButton") {
    const session = renderer.xr.getSession();
    if (session) session.end();
    return;
  }
  if (hit.object.name === "xrModeButton") {
    scenarioMode = scenarioMode === "guided" ? "challenge" : "guided";
    updateXRWelcomePanel();
    return;
  }
  if (hit.object.name === "xrDifficultyButton") {
    const levels = ["practice", "standard", "intense"];
    scenarioDifficulty = levels[(levels.indexOf(scenarioDifficulty) + 1) % levels.length];
    updateXRWelcomePanel();
    return;
  }
  if (hit.object.name === "xrStartButton") {
    if (!window.userData) {
      window.userData = { name: "Guest", surname: "User", startTime: new Date().toLocaleString("en-GB") };
    }
    if (xrWelcomePanel) xrWelcomePanel.visible = false;
    startScenario();
    return;
  }

  let object = hit.object;
  while (object && object.parent && object.parent !== room &&
    !["Door", "shelterZone", "desk"].includes(object.name)) {
    object = object.parent;
  }

  if (["Door", "shelterZone", "desk"].includes(object?.name)) {
    handleInteraction(object);
    return;
  }

  let physicsObject = hit.object;
  while (physicsObject && physicsObject !== room && !physicsObject.userData?.physics) {
    physicsObject = physicsObject.parent;
  }
  const physics = physicsObject?.userData?.physics;
  if (awaitingExit && physics && (physics.toppled || physics.broken)) {
    const label = physics.label || "Object";
    const action = "hazard_observed";
    if (!decisionLog.some((entry) => entry.action === action && entry.description === label)) {
      logDecision(action, "Inspected hazard: " + label);
      showMessage("Hazard noted: " + label, 1600);
    } else {
      showMessage("You already inspected this hazard.", 1200);
    }
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);

  render();
}

function render() {
  // EffectComposer is not used while presenting immersive XR frames.
  if (renderer && renderer.xr.isPresenting) {
    renderer.render(scene, camera);
  } else if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ----------------- ROOM ------------------------

async function createRoom() {
  room = new THREE.Group();

  const roomSize = 5;
  const wallHeight = 3;
  const wallThickness = 0.1;

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xf5f5f0,
    roughness: 0.9,
    metalness: 0.05,
  });

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x8b6914,
    roughness: 0.8,
    metalness: 0.05,
  });

  const ceilingMaterial = new THREE.MeshStandardMaterial({
    color: 0xfafafa,
    roughness: 0.95,
    metalness: 0.02,
  });

  const floorGeometry = new THREE.BoxGeometry(roomSize, wallThickness, roomSize);
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.y = -wallThickness / 2;
  floor.receiveShadow = true;
  room.add(floor);

  const ceilingGeometry = new THREE.BoxGeometry(roomSize, wallThickness, roomSize);
  const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
  ceiling.position.y = wallHeight;
  ceiling.receiveShadow = true;
  room.add(ceiling);

  const backWallGeometry = new THREE.BoxGeometry(
    roomSize,
    wallHeight,
    wallThickness
  );
  const backWall = new THREE.Mesh(backWallGeometry, wallMaterial);
  backWall.position.set(0, wallHeight / 2, -roomSize / 2);
  backWall.receiveShadow = true;
  backWall.castShadow = true;
  room.add(backWall);

  const leftWallGeometry = new THREE.BoxGeometry(
    wallThickness,
    wallHeight,
    roomSize
  );
  const leftWall = new THREE.Mesh(leftWallGeometry, wallMaterial);
  leftWall.position.set(-roomSize / 2, wallHeight / 2, 0);
  leftWall.receiveShadow = true;
  leftWall.castShadow = true;
  room.add(leftWall);

  const rightWallGeometry = new THREE.BoxGeometry(
    wallThickness,
    wallHeight,
    roomSize
  );
  const rightWall = new THREE.Mesh(rightWallGeometry, wallMaterial);
  rightWall.position.set(roomSize / 2, wallHeight / 2, 0);
  rightWall.receiveShadow = true;
  rightWall.castShadow = true;
  room.add(rightWall);

  const frontRightGeo = new THREE.BoxGeometry(2.0, wallHeight, wallThickness);
  const frontRight = new THREE.Mesh(frontRightGeo, wallMaterial);
  frontRight.position.set(1.5, wallHeight / 2, roomSize / 2);
  frontRight.castShadow = true;
  frontRight.receiveShadow = true;
  room.add(frontRight);

  const frontLeftGeo = new THREE.BoxGeometry(2.0, wallHeight, wallThickness);
  const frontLeft = new THREE.Mesh(frontLeftGeo, wallMaterial);
  frontLeft.position.set(-1.5, wallHeight / 2, roomSize / 2);
  frontLeft.castShadow = true;
  frontLeft.receiveShadow = true;
  room.add(frontLeft);

  const doorHeight = 2.2;
  const frontTopGeo = new THREE.BoxGeometry(
    1.0,
    wallHeight - doorHeight,
    wallThickness
  );
  const frontTop = new THREE.Mesh(frontTopGeo, wallMaterial);
  frontTop.position.set(
    0,
    doorHeight + (wallHeight - doorHeight) / 2,
    roomSize / 2
  );
  frontTop.castShadow = true;
  frontTop.receiveShadow = true;
  room.add(frontTop);

  const doorWidth = 1.0;
  const doorThick = 0.05;
  const doorGeo = new THREE.BoxGeometry(doorWidth, doorHeight, doorThick);
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x442200,
    roughness: 0.6,
  });
  const doorMesh = new THREE.Mesh(doorGeo, doorMat);

  const doorGroup = new THREE.Group();
  doorGroup.position.set(-0.5, doorHeight / 2, roomSize / 2);

  doorMesh.position.set(doorWidth / 2, 0, 0);
  doorMesh.name = "Door";
  doorGroup.add(doorMesh);

  const handleGeo = new THREE.SphereGeometry(0.05);
  const handleMat = new THREE.MeshStandardMaterial({
    color: 0xaaaaaa,
    metalness: 0.8,
  });
  const handle = new THREE.Mesh(handleGeo, handleMat);
  handle.position.set(doorWidth - 0.1, 0, 0.05);
  handle.name = "Door";
  doorGroup.add(handle);

  const handleInside = new THREE.Mesh(handleGeo, handleMat);
  handleInside.position.set(doorWidth - 0.1, 0, -0.05);
  handleInside.name = "Door";
  doorGroup.add(handleInside);

  doorGroup.name = "DoorGroup";
  room.add(doorGroup);
  window.doorGroup = doorGroup;
  window.isDoorOpen = false;

  loader.load(
    "exit_box.glb",
    (gltf) => {
      const exitSign = gltf.scene;

      exitSign.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      exitSign.position.set(
        0,
        doorHeight + 0.15,
        roomSize / 2 - wallThickness / 2 - 0.01
      );

      exitSign.scale.set(0.65, 0.65, 0.65);
      exitSign.rotation.y = Math.PI / 2;

      room.add(exitSign);
    },
    undefined,
    () => {}
  );

  const outFloorGeo = new THREE.BoxGeometry(roomSize, wallThickness, 4.0);
  const outFloorMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const outFloor = new THREE.Mesh(outFloorGeo, outFloorMat);
  outFloor.position.set(0, -wallThickness / 2, 4.5);
  outFloor.receiveShadow = true;
  room.add(outFloor);

  await loadAllRealisticModels();

  let desk = null;
  if (loadedModels.desk) {
    desk = loadedModels.desk;
    desk.name = "desk";
    desk.traverse((child) => {
      if (child.isMesh) child.name = "desk";
    });
    room.add(desk);
  } else {
    desk = createFallbackDesk();
  }
  registerPhysicsObject(desk, {
    mass: 40,
    stability: 0.95,
    allowTopple: false,
    label: "Desk",
    profile: "desk",
  });

  createShelterZoneForObject(desk);

  let monitor = null;
  let keyboard = null;
  let computerMouse = null;

  if (loadedModels.monitor) {
    monitor = loadedModels.monitor;
    monitor.name = "monitor";
    room.add(monitor);
  } else {
    monitor = createFallbackMonitor(Boolean(loadedModels.desk));
  }

  if (loadedModels.keyboard) {
    // The bundled asset contains both the keyboard and mouse, so track it as one
    // movable assembly rather than pretending the GLB exposes two separate props.
    keyboard = loadedModels.keyboard;
    keyboard.name = "keyboardMouse";
    room.add(keyboard);
  } else {
    const inputProps = createFallbackKeyboardAndMouse(Boolean(loadedModels.desk));
    keyboard = inputProps.keyboard;
    computerMouse = inputProps.mouse;
  }

  registerPhysicsObject(monitor, {
    mass: 3.5,
    stability: 0.2,
    allowTopple: true,
    label: "Monitor",
    profile: "monitor",
  });
  registerPhysicsObject(keyboard, {
    mass: 1.8,
    stability: 0.4,
    allowTopple: true,
    label: computerMouse ? "Keyboard" : "Keyboard and mouse",
    profile: "smallItem",
  });
  registerPhysicsObject(computerMouse, {
    mass: 1.1,
    stability: 0.35,
    allowTopple: true,
    label: "Mouse",
    profile: "smallItem",
  });

  if (loadedModels.chair) {
    room.add(loadedModels.chair);
    registerPhysicsObject(loadedModels.chair, {
      mass: 12,
      stability: 0.6,
      allowTopple: true,
      label: "Office chair",
      profile: "officeChair",
    });
  } else {
    const fallbackChair = createFallbackChair();
    registerPhysicsObject(fallbackChair, {
      mass: 10,
      stability: 0.55,
      allowTopple: true,
      label: "Chair",
      profile: "officeChair",
    });
  }

  if (loadedModels.guestChair1) {
    room.add(loadedModels.guestChair1);
    registerPhysicsObject(loadedModels.guestChair1, {
      mass: 8,
      stability: 0.5,
      allowTopple: true,
      label: "Guest chair",
      profile: "guestChair",
    });
  }

  if (loadedModels.guestChair2) {
    room.add(loadedModels.guestChair2);
    registerPhysicsObject(loadedModels.guestChair2, {
      mass: 8,
      stability: 0.5,
      allowTopple: true,
      label: "Guest chair",
      profile: "guestChair",
    });
  }

  if (loadedModels.plant) {
    room.add(loadedModels.plant);
    registerPhysicsObject(loadedModels.plant, {
      mass: 3.5,
      stability: 0.25,
      allowTopple: true,
      label: "Plant",
      profile: "plant",
    });
  }

  let heater = null;
  if (loadedModels.heater) {
    heater = loadedModels.heater;
    heater.name = "heater";
    room.add(heater);
    registerPhysicsObject(heater, {
      mass: 12,
      stability: 0.6,
      allowTopple: true,
      label: "Heater",
      profile: "heater",
    });
  } else {
    const fallbackHeater = createFallbackHeater();
    heater = fallbackHeater;
    registerPhysicsObject(fallbackHeater, {
      mass: 10,
      stability: 0.55,
      allowTopple: true,
      label: "Heater",
      profile: "heater",
    });
  }

  let electricalPanel = null;
  if (loadedModels.electricalPanel) {
    electricalPanel = loadedModels.electricalPanel;
    room.add(electricalPanel);
  } else {
    electricalPanel = createElectricalPanel();
  }

  registerNoCoverZone(heater, { x: 0.7, y: 1.2, z: 0.7 }, "Heater");
  registerNoCoverZone(electricalPanel, { x: 0.6, y: 1.0, z: 0.6 }, "Electrical panel");

  scene.add(room);
}

function createShelterZoneForObject(object) {
  if (!object) return;

  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const zoneHeight = Math.max(2.0, size.y * 1.2);
  const zoneWidth = Math.max(1.3, size.x + 0.9);
  const zoneDepth = Math.max(1.1, size.z + 0.9);

  const zone = new THREE.Mesh(
    new THREE.BoxGeometry(zoneWidth, zoneHeight, zoneDepth),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  zone.position.set(center.x, zoneHeight / 2, center.z);
  zone.name = "shelterZone";
  zone.userData.coverPoint = new THREE.Vector3(
    center.x,
    Math.max(0.85, Math.min(EYE_HEIGHT_CROUCH, box.min.y + 0.6)),
    center.z
  );

  room.add(zone);
  shelterZone = zone;
}

function registerNoCoverZone(object, padding, label) {
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object);
  const pad = new THREE.Vector3(padding.x, padding.y, padding.z);
  box.min.sub(pad);
  box.max.add(pad);
  noCoverZones.push({ box, label });
}

// ==================== FALLBACK MODELS ====================

function createFallbackDesk() {
  const desk = new THREE.Group();
  desk.name = "desk";

  const deskGeometry = new THREE.BoxGeometry(1.5, 0.05, 0.8);
  const deskMaterial = new THREE.MeshStandardMaterial({
    color: 0x5c4033,
    roughness: 0.7,
    metalness: 0.1,
  });
  const tabletop = new THREE.Mesh(deskGeometry, deskMaterial);
  tabletop.position.set(0, 0.75, 0);
  tabletop.castShadow = true;
  tabletop.receiveShadow = true;
  tabletop.name = "desk";
  desk.add(tabletop);

  const legGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.72, 12);
  const legMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.4,
    metalness: 0.6,
  });

  const positions = [
    [-0.68, 0.36, -0.35],
    [0.68, 0.36, -0.35],
    [-0.68, 0.36, 0.35],
    [0.68, 0.36, 0.35],
  ];

  positions.forEach((pos) => {
    const leg = new THREE.Mesh(legGeometry, legMaterial);
    leg.position.set(pos[0], pos[1], pos[2]);
    leg.castShadow = true;
    leg.name = "desk";
    desk.add(leg);
  });

  room.add(desk);
  return desk;
}

function createFallbackMonitor(hasLoadedDesk = false) {
  const monitorAssembly = new THREE.Group();
  monitorAssembly.name = "monitor";
  const monitorGeometry = new THREE.BoxGeometry(0.55, 0.38, 0.04);
  const monitorMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.2,
    metalness: 0.7,
  });
  const monitor = new THREE.Mesh(monitorGeometry, monitorMaterial);
  monitor.position.set(0, 0.11, 0);
  monitor.rotation.x = -0.08;
  monitor.castShadow = true;
  monitor.receiveShadow = true;
  monitor.name = "monitor";
  monitorAssembly.add(monitor);

  const screenGeometry = new THREE.BoxGeometry(0.5, 0.32, 0.01);
  const screenMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a8cff,
    emissive: 0x0055aa,
    emissiveIntensity: 0.6,
    roughness: 0.05,
    metalness: 0.1,
  });
  const screen = new THREE.Mesh(screenGeometry, screenMaterial);
  screen.position.set(0, 0.11, 0.025);
  screen.rotation.x = -0.08;
  screen.name = "monitor";
  monitorAssembly.add(screen);

  const neckGeometry = new THREE.BoxGeometry(0.06, 0.15, 0.06);
  const standMaterial = new THREE.MeshStandardMaterial({
    color: 0x222222,
    roughness: 0.4,
    metalness: 0.6,
  });
  const neck = new THREE.Mesh(neckGeometry, standMaterial);
  neck.position.set(0, -0.015, 0);
  neck.name = "monitor";
  monitorAssembly.add(neck);

  const baseGeometry = new THREE.CylinderGeometry(0.12, 0.14, 0.02, 24);
  const base = new THREE.Mesh(baseGeometry, standMaterial);
  base.position.set(0, -0.085, 0);
  base.name = "monitor";
  monitorAssembly.add(base);
  monitorAssembly.position.set(0, 0.87, hasLoadedDesk ? -2.0 : -0.18);
  room.add(monitorAssembly);
  return monitorAssembly;
}

function createFallbackKeyboardAndMouse(hasLoadedDesk = false) {
  const keyboardGeometry = new THREE.BoxGeometry(0.42, 0.015, 0.14);
  const keyboardMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.6,
    metalness: 0.3,
  });
  const keyboard = new THREE.Mesh(keyboardGeometry, keyboardMaterial);
  keyboard.position.set(hasLoadedDesk ? -0.2 : 0, 0.785, hasLoadedDesk ? -1.45 : 0.12);
  keyboard.castShadow = true;
  keyboard.name = "keyboard";
  room.add(keyboard);

  const mouseGeometry = new THREE.BoxGeometry(0.055, 0.025, 0.095);
  const mouseMaterial = new THREE.MeshStandardMaterial({
    color: 0x333333,
    roughness: 0.4,
    metalness: 0.4,
  });
  const computerMouse = new THREE.Mesh(mouseGeometry, mouseMaterial);
  computerMouse.position.set(hasLoadedDesk ? 0.28 : 0.28, 0.79, hasLoadedDesk ? -1.35 : 0.15);
  computerMouse.castShadow = true;
  computerMouse.name = "mouse";
  room.add(computerMouse);

  return { keyboard, mouse: computerMouse };
}
function createFallbackChair() {
  const chairGroup = new THREE.Group();

  const seatGeometry = new THREE.BoxGeometry(0.45, 0.06, 0.45);
  const seatMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.8,
    metalness: 0.1,
  });
  const seat = new THREE.Mesh(seatGeometry, seatMaterial);
  seat.position.y = 0.45;
  chairGroup.add(seat);

  const backGeometry = new THREE.BoxGeometry(0.42, 0.5, 0.05);
  const back = new THREE.Mesh(backGeometry, seatMaterial);
  back.position.set(0, 0.73, -0.2);
  back.rotation.x = 0.1;
  chairGroup.add(back);

  const legGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.25, 12);
  const legMaterial = new THREE.MeshStandardMaterial({
    color: 0x333333,
    roughness: 0.3,
    metalness: 0.8,
  });
  const centerLeg = new THREE.Mesh(legGeometry, legMaterial);
  centerLeg.position.y = 0.3;
  chairGroup.add(centerLeg);

  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2;
    const wheelLeg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.25, 8),
      legMaterial
    );
    wheelLeg.position.set(Math.cos(angle) * 0.18, 0.08, Math.sin(angle) * 0.18);
    wheelLeg.rotation.z = (Math.PI / 6) * (angle > Math.PI ? 1 : -1);
    chairGroup.add(wheelLeg);

    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.03, 12),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 })
    );
    wheel.position.set(Math.cos(angle) * 0.25, 0.015, Math.sin(angle) * 0.25);
    wheel.rotation.z = Math.PI / 2;
    chairGroup.add(wheel);
  }

  chairGroup.position.set(0, 0, 0.9);
  chairGroup.rotation.y = Math.PI + 0.2;
  room.add(chairGroup);

  return chairGroup;
}

function createFallbackHeater() {
  const heater = new THREE.Group();
  heater.name = "heater";
  heater.position.set(0.35, 0.19, 0.15);

  const heaterGeometry = new THREE.CylinderGeometry(0.16, 0.19, 0.38, 20);
  const heaterMaterial = new THREE.MeshStandardMaterial({
    color: 0x6e6e6e,
    roughness: 0.55,
    metalness: 0.35,
  });
  const heaterBody = new THREE.Mesh(heaterGeometry, heaterMaterial);
  heaterBody.castShadow = true;
  heaterBody.receiveShadow = true;
  heaterBody.name = "heater";
  heater.add(heaterBody);

  const rimGeometry = new THREE.TorusGeometry(0.17, 0.015, 8, 24);
  const rimMaterial = new THREE.MeshStandardMaterial({
    color: 0x505050,
    roughness: 0.4,
    metalness: 0.6,
  });
  const rim = new THREE.Mesh(rimGeometry, rimMaterial);
  rim.position.set(0, 0.19, 0);
  rim.rotation.x = Math.PI / 2;
  rim.name = "heater";
  heater.add(rim);

  room.add(heater);
  return heater;
}

function createElectricalPanel() {
  const panelX = 2.4;
  const panelY = 1.2;
  const panelZ = -1.8;

  const panelGeometry = new THREE.BoxGeometry(0.12, 0.7, 0.5);
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: 0x666666,
    roughness: 0.5,
    metalness: 0.6,
  });
  const panel = new THREE.Mesh(panelGeometry, panelMaterial);
  panel.position.set(panelX, panelY, panelZ);
  panel.castShadow = true;
  room.add(panel);

  const doorGeometry = new THREE.BoxGeometry(0.03, 0.65, 0.45);
  const doorMaterial = new THREE.MeshStandardMaterial({
    color: 0xaaaaaa,
    roughness: 0.4,
    metalness: 0.5,
  });
  const door = new THREE.Mesh(doorGeometry, doorMaterial);
  door.position.set(panelX - 0.06, panelY, panelZ);
  room.add(door);

  return panel;
}

// ----------------- HANDS ------------------------

function createProceduralHands() {
  handsGroup = new THREE.Group();

  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xe0ac69,
    roughness: 0.6,
    metalness: 0.05,
  });

  const createHand = (isRight) => {
    const handGroup = new THREE.Group();
    const side = isRight ? 1 : -1;

    const armGeo = new THREE.CylinderGeometry(0.04, 0.045, 0.5, 12);
    const arm = new THREE.Mesh(armGeo, skinMaterial);
    arm.rotation.x = Math.PI / 2 - 0.2;
    arm.position.set(0.25 * side, -0.35, -0.15);
    handGroup.add(arm);

    const palmGeo = new THREE.BoxGeometry(0.1, 0.03, 0.12);
    const palm = new THREE.Mesh(palmGeo, skinMaterial);
    palm.position.set(0.25 * side, -0.28, -0.42);
    palm.rotation.x = -0.1;
    handGroup.add(palm);

    const fingerGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8);
    for (let i = 0; i < 4; i += 1) {
      const finger = new THREE.Mesh(fingerGeo, skinMaterial);
      finger.rotation.x = Math.PI / 2;
      finger.position.set(
        0.25 * side + (i * 0.025 - 0.0375) * side,
        -0.27,
        -0.49
      );
      handGroup.add(finger);
    }

    const thumb = new THREE.Mesh(fingerGeo, skinMaterial);
    thumb.rotation.x = Math.PI / 2;
    thumb.rotation.y = side * 0.5;
    thumb.position.set(0.25 * side - 0.06 * side, -0.28, -0.44);
    handGroup.add(thumb);

    return handGroup;
  };

  handsGroup.add(createHand(false));
  handsGroup.add(createHand(true));

  camera.add(handsGroup);
}

function updateHands() {
  if (!handsGroup) return;

  if (moveState.forward || moveState.backward || moveState.left || moveState.right) {
    const time = Date.now() * 0.005;
    handsGroup.position.y = Math.sin(time) * 0.01;
    handsGroup.position.x = Math.cos(time * 0.5) * 0.005;
  } else {
    const time = Date.now() * 0.001;
    handsGroup.position.y = Math.sin(time) * 0.005;
  }
}

// ----------------- ANIMATE ------------------------

function animate() {
  deltaTime = clock.getDelta();

  if (controls && controls.update) controls.update();

  updateFirstPersonMovement(deltaTime);
  updateInteraction();

  if (!guiObject.pauseBoolean) {
    updateEarthquake(deltaTime);
  }

  updateHands();
  updateObjectivePanel();

  updateStatus();
  updateXRInterface();

  if (timerStarted && !scenarioEnded) {
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const timerDiv = document.getElementById("timer");
    if (timerDiv) {
      timerDiv.textContent = `Elapsed time: ${elapsedTime} s`;
    }
  }

  render();
  renderer.toneMappingExposure = guiObject.value3;
}

// ----------------- OBJECTIVES AND ROOM TOUR ------------------------
function scanVisibleHazards() {
  if (!awaitingExit) {
    showMessage("Wait until all shaking stops before checking the room for hazards.", 2200);
    return;
  }
  if (decisionLog.some((entry) => entry.action === "hazard_scan_complete")) {
    showMessage("Hazard scan already completed. Review the checklist before exiting.", 1800);
    return;
  }
  const hazards = physicsObjects.filter((object) => {
    const data = object.userData.physics;
    return data && (data.toppled || data.broken);
  });
  const names = hazards.map((object) => object.userData.physics.label || object.name || "Object");
  logDecision("hazard_scan_complete", "Completed post-shaking hazard scan: " + hazards.length + " simulated hazard(s)");
  const output = document.getElementById("hazardScanResult");
  if (output) {
    output.textContent = hazards.length
      ? "Check these simulated hazards before exiting: " + names.join(", ") + "."
      : "No toppled or damaged objects were detected by the simulation. Still look around carefully before exiting.";
  }
  showMessage(hazards.length ? "Hazard scan complete. Review the checklist." : "Scan complete. Still check your surroundings.", 2200);
}

document.getElementById("scanHazardsBtn")?.addEventListener("click", scanVisibleHazards);

function updateObjectivePanel() {
  const panel = document.getElementById("objectivePanel");
  if (!panel) return;
  const objectives = [
    { id: "objectiveCover", complete: coverUsed },
    { id: "objectiveHold", complete: coverTimeTotal >= 3 },
    { id: "objectiveScan", complete: decisionLog.some((entry) => entry.action === "hazard_scan_complete") },
    { id: "objectiveExit", complete: exitCompleted },
  ];
  objectives.forEach((objective) => {
    const item = document.getElementById(objective.id);
    if (!item) return;
    item.classList.toggle("is-complete", objective.complete);
    const state = item.querySelector(".objective-state");
    if (state) state.textContent = objective.complete ? "Complete" : "In progress";
  });
}

let tourOverlay;

function showTourMessage(text) {
  if (!tourOverlay) {
    tourOverlay = document.createElement("div");
    tourOverlay.style.position = "fixed";
    tourOverlay.style.bottom = "20%";
    tourOverlay.style.left = "50%";
    tourOverlay.style.transform = "translate(-50%, 0)";
    tourOverlay.style.backgroundColor = "rgba(0,0,0,0.8)";
    tourOverlay.style.color = "#00ff00";
    tourOverlay.style.padding = "20px 40px";
    tourOverlay.style.fontSize = "24px";
    tourOverlay.style.fontWeight = "bold";
    tourOverlay.style.borderRadius = "15px";
    tourOverlay.style.border = "2px solid #00ff00";
    tourOverlay.style.textAlign = "center";
    tourOverlay.style.zIndex = "10000";
    tourOverlay.style.transition = "opacity 0.5s";
    tourOverlay.style.pointerEvents = "none";
    document.body.appendChild(tourOverlay);
  }

  tourOverlay.textContent = text;
  tourOverlay.style.opacity = "1";
}

function hideTourMessage() {
  if (tourOverlay) tourOverlay.style.opacity = "0";
}

function tweenCameraLookAt(targetPos, targetLookAt, duration) {
  return new Promise((resolve) => {
    const startPos = camera.position.clone();

    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyQuaternion(camera.quaternion);
    const startLookAt = startPos.clone().add(forward.multiplyScalar(2));

    const startTime = Date.now();

    function update() {
      const now = Date.now();
      let progress = (now - startTime) / duration;
      if (progress > 1) progress = 1;

      const ease =
        progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      camera.position.lerpVectors(startPos, targetPos, ease);

      const currentLook = new THREE.Vector3().lerpVectors(
        startLookAt,
        targetLookAt,
        ease
      );
      camera.lookAt(currentLook);

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        resolve();
      }
    }
    update();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRoomTour() {
  if (controls) controls.unlock();

  const initialPos = new THREE.Vector3(0, 1.6, 2.0);
  const centerPos = new THREE.Vector3(0, 1.6, 0.5);

  const targets = [
    {
      pos: centerPos,
      look: new THREE.Vector3(0, 0.8, -1.5),
      text: "Move near the desk; this is the designated cover area in this simulation.",
      wait: 2000,
    },
    {
      pos: centerPos,
      look: new THREE.Vector3(2.4, 1.2, -1.8),
      text: "Objects may move or topple during shaking; avoid unstable furniture.",
      wait: 2500,
    },
    {
      pos: new THREE.Vector3(0, 1.6, 0),
      look: new THREE.Vector3(0, 1.5, 3.0),
      text: "After shaking stops, check for hazards and use the exit when it is safe.",
      wait: 2000,
    },
  ];

  for (const target of targets) {
    showTourMessage(target.text);
    await tweenCameraLookAt(target.pos, target.look, 1500);
    await sleep(target.wait);
  }

  hideTourMessage();
  showTourMessage("Simulation starting. Get ready...", 2000);

  await tweenCameraLookAt(initialPos, new THREE.Vector3(0, 1.6, -2.0), 1500);

  await sleep(1000);
  hideTourMessage();

  const startBtn = document.getElementById("startScenarioBtn");
  if (startBtn) {
    startBtn.style.display = "block";
    startBtn.style.transform = "translate(-50%, -50%) scale(1.1)";
    startBtn.style.transition = "transform 0.5s";
    setTimeout(() => {
      startBtn.style.transform = "translate(-50%, -50%) scale(1.0)";
    }, 500);
  }
}

function startScenario() {
  if (timerStarted || scenarioEnded) return;

  const startBtn = document.getElementById("startScenarioBtn");
  if (startBtn) startBtn.style.display = "none";

  const instructionsDiv = document.getElementById("instructions");
  if (instructionsDiv && !instructionsDiv.classList.contains("collapsed")) {
    instructionsDiv.classList.add("collapsed");
  }

  const statusDiv = document.getElementById("quakeStatus");
  if (statusDiv) {
    statusDiv.textContent = "Entering the office...";
    statusDiv.style.color = "#ffffff";
    statusDiv.style.borderColor = "#ffffff";
  }

  if (!(renderer && renderer.xr.isPresenting) && controls && !controls.isLocked) {
    controls.lock();
  }

  initRumbleAudio();
  buildQuakeTimeline();
  const objectivePanel = document.getElementById("objectivePanel");
  if (objectivePanel) objectivePanel.style.display = "block";
  const objectiveMode = document.getElementById("objectiveMode");
  if (objectiveMode) objectiveMode.textContent = (scenarioMode === "guided" ? "Guided practice" : "Challenge mode") + " · " + scenarioDifficulty;

  scenarioStartTime = Date.now();
  startTime = scenarioStartTime;
  exitCompleted = false;
  exitPromptedWithoutScan = false;
  awaitingExit = false;
  scenarioEnded = false;
  coverUsed = false;
  coverTimeTotal = 0;
  userScore = 0;
  coverResponseScore = 0;
  coverResponseRawScore = 0;
  coverDurationScore = 0;
  decisionLog = [];
  timerStarted = true;

  setTimeout(() => {
    if (statusDiv) {
      statusDiv.textContent = "Earthquake started! Find the designated cover area.";
      statusDiv.style.color = "#ff8800";
      statusDiv.style.borderColor = "#ff8800";
      statusDiv.style.animation = "pulse 0.5s infinite";
    }

    const timerDiv = document.getElementById("timer");
    if (timerDiv) timerDiv.style.display = "block";

    const crosshair = document.getElementById("crosshair");
    if (crosshair) crosshair.style.display = "block";
  }, 1500);
}

function validateAndStart() {
  const nameInput = document.getElementById("userName");
  const surnameInput = document.getElementById("userSurname");

  const name = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "Unknown";
  const surname = surnameInput && surnameInput.value.trim() ? surnameInput.value.trim() : "User";
  scenarioMode = document.getElementById("scenarioMode")?.value || "guided";
  scenarioDifficulty = document.getElementById("scenarioDifficulty")?.value || "standard";

  window.userData = {
    name,
    surname,
    startTime: new Date().toLocaleString("en-GB"),
  };

  const controlsIntro = document.getElementById("controls-intro");
  if (controlsIntro) {
    controlsIntro.style.display = "none";
  }

  if (renderer && renderer.xr.isPresenting) {
    showTourMessage("Ready to begin. Use the controls panel to start the scenario.");
    setTimeout(() => {
      hideTourMessage();
      const startButton = document.getElementById("startScenarioBtn");
      if (startButton) startButton.style.display = "block";
    }, 1200);
  } else if (scenarioMode === "guided") {
    runRoomTour();
  } else {
    if (camera) {
      camera.position.set(0, EYE_HEIGHT, 2);
      camera.rotation.set(0, 0, 0);
    }
    showTourMessage("Challenge mode selected. Explore the room and prepare to respond.");
    setTimeout(() => {
      hideTourMessage();
      const startButton = document.getElementById("startScenarioBtn");
      if (startButton) startButton.style.display = "block";
    }, 1800);
  }
}

window.earthquakeSimulation = {
  startScenario,
  runRoomTour,
};

window.validateAndStart = validateAndStart;


const knowledgeQuestions = [
  {
    prompt: "When shaking begins, what should you do first?",
    options: [
      "Run outside immediately",
      "Drop to your hands and knees and protect your head and neck",
      "Stand in a doorway and wait"
    ],
    correct: 1,
    explanation: "Drop, Cover, and Hold On. Protect your head and neck as soon as shaking starts."
  },
  {
    prompt: "If a sturdy desk or table is nearby during shaking, what should you do?",
    options: [
      "Get underneath it and hold on",
      "Stand beside a window",
      "Run across the room to collect belongings"
    ],
    correct: 0,
    explanation: "If possible, take cover under a sturdy desk or table and hold on until shaking stops."
  },
  {
    prompt: "What should you do after the shaking stops?",
    options: [
      "Rush toward the nearest exit without looking around",
      "Assume there will be no aftershocks",
      "Check for hazards and leave carefully when it is safe"
    ],
    correct: 2,
    explanation: "Look for hazards, expect possible aftershocks, and evacuate carefully when safe."
  }
];

function openKnowledgeCheck() {
  const panel = document.getElementById("knowledgeCheck");
  const questionsContainer = document.getElementById("assessmentQuestions");
  const feedback = document.getElementById("assessmentFeedback");
  const submitButton = document.getElementById("assessmentSubmit");
  if (!panel || !questionsContainer || !feedback || !submitButton) return;

  questionsContainer.replaceChildren();
  feedback.textContent = "";
  submitButton.textContent = "Submit answers";
  submitButton.dataset.completed = "false";
  postKnowledgeScore = null;

  knowledgeQuestions.forEach((question, questionIndex) => {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "assessment-question";
    const legend = document.createElement("legend");
    legend.textContent = (questionIndex + 1) + ". " + question.prompt;
    fieldset.appendChild(legend);

    question.options.forEach((option, optionIndex) => {
      const label = document.createElement("label");
      label.className = "assessment-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "knowledge-question-" + questionIndex;
      input.value = String(optionIndex);
      label.append(input, document.createTextNode(option));
      fieldset.appendChild(label);
    });

    questionsContainer.appendChild(fieldset);
  });

  panel.style.display = "block";
  panel.setAttribute("aria-hidden", "false");
}

function submitKnowledgeCheck() {
  const panel = document.getElementById("knowledgeCheck");
  const questionsContainer = document.getElementById("assessmentQuestions");
  const feedback = document.getElementById("assessmentFeedback");
  const submitButton = document.getElementById("assessmentSubmit");
  if (!panel || !questionsContainer || !feedback || !submitButton) return;

  if (submitButton.dataset.completed === "true") {
    panel.style.display = "none";
    panel.setAttribute("aria-hidden", "true");
    const summary = document.getElementById("knowledgeCheckSummary");
    if (summary) summary.textContent = "Safety knowledge check: " + postKnowledgeScore + "/3 correct.";
    const results = document.getElementById("resultScreen");
    if (results) results.style.display = "block";
    return;
  }

  const answers = knowledgeQuestions.map((question, index) => {
    const selected = questionsContainer.querySelector('input[name="knowledge-question-' + index + '"]:checked');
    return selected ? Number(selected.value) : -1;
  });

  if (answers.some((answer) => answer < 0)) {
    feedback.textContent = "Please answer all three questions before submitting.";
    feedback.style.color = "#ffcc66";
    return;
  }

  postKnowledgeScore = answers.reduce((score, answer, index) => {
    return score + (answer === knowledgeQuestions[index].correct ? 1 : 0);
  }, 0);

  knowledgeQuestions.forEach((question, index) => {
    const fieldset = questionsContainer.children[index];
    const explanation = document.createElement("p");
    explanation.className = "assessment-explanation";
    explanation.textContent = (answers[index] === question.correct ? "Correct. " : "Review. ") + question.explanation;
    fieldset.appendChild(explanation);
    fieldset.querySelectorAll("input").forEach((input) => {
      input.disabled = true;
    });
  });

  feedback.textContent = "You answered " + postKnowledgeScore + " of 3 questions correctly. Review the explanations, then return to your scenario results.";
  feedback.style.color = "#ffffff";
  submitButton.textContent = "Back to results";
  submitButton.dataset.completed = "true";
}

document.getElementById("takeKnowledgeCheckBtn")?.addEventListener("click", () => {
  const results = document.getElementById("resultScreen");
  if (results) results.style.display = "none";
  openKnowledgeCheck();
});

document.getElementById("assessmentSubmit")?.addEventListener("click", submitKnowledgeCheck);
document.getElementById("tryAgainBtn")?.addEventListener("click", () => location.reload());

document.getElementById("downloadReportBtn")?.addEventListener("click", () => {
  if (!lastScenarioReport) return;
  const report = lastScenarioReport;
  coverResponseScore = report.coverResponseScore;
  coverDurationScore = report.coverDurationScore;
  exportToCSV(report.totalTime, report.score, report.resultText, report.toppledCount, report.damagedCount);
});

window.addEventListener("load", () => {
  setTimeout(() => {
    if (controls) controls.unlock();

    const controlsIntro = document.getElementById("controls-intro");
    if (controlsIntro) {
      controlsIntro.style.display = "block";
    }
  }, 1000);
});

// ----------------- INTERACTION ------------------------

function updateInteraction() {
  if (!controls.isLocked && !(renderer && renderer.xr.isPresenting)) {
    if (interactionHintDiv) interactionHintDiv.style.display = "none";
    return;
  }

  if (renderer && renderer.xr.isPresenting) {
    if (interactionHintDiv) interactionHintDiv.style.display = "none";
    return;
  }

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

  let foundInteractable = null;
  let hintText = "";

  if (room) {
    const intersects = raycaster.intersectObjects(room.children, true);
    if (intersects.length > 0) {
      const object = intersects[0].object;

      if (intersects[0].distance < 3.0) {
        if (object.name === "Door") {
          foundInteractable = object;
          const actionText = window.isDoorOpen ? "close" : "open";
          hintText = `Press [E] to ${actionText} the door`;
        } else if (object.name === "shelterZone" || object.name === "desk") {
          foundInteractable = object;
          hintText = "Press [E] to take cover";
        }
      }
    }
  }

  if (!foundInteractable && shelterZone && isCameraInShelter()) {
    foundInteractable = shelterZone;
    hintText = coverActive ? "COVER ACTIVE" : "Press [E] to take cover";
  }

  if (!foundInteractable) {
    const noCoverReason = getNoCoverReason();
    if (noCoverReason) {
      foundInteractable = shelterZone;
      hintText = `No cover available near ${noCoverReason}`;
    }
  }

  currentInteractable = foundInteractable;

  if (!interactionHintDiv) {
    interactionHintDiv = document.createElement("div");
    interactionHintDiv.style.position = "fixed";
    interactionHintDiv.style.top = "55%";
    interactionHintDiv.style.left = "50%";
    interactionHintDiv.style.transform = "translate(-50%, -50%)";
    interactionHintDiv.style.color = "#ffffff";
    interactionHintDiv.style.fontFamily = "Arial, sans-serif";
    interactionHintDiv.style.fontSize = "18px";
    interactionHintDiv.style.fontWeight = "bold";
    interactionHintDiv.style.textShadow = "0px 0px 5px #000000";
    interactionHintDiv.style.pointerEvents = "none";
    interactionHintDiv.style.display = "none";
    interactionHintDiv.style.zIndex = "1000";
    document.body.appendChild(interactionHintDiv);
  }

  if (currentInteractable) {
    interactionHintDiv.textContent = hintText;
    interactionHintDiv.style.display = "block";
    const crosshair = document.getElementById("crosshair");
    if (crosshair) crosshair.style.backgroundColor = "rgba(255, 255, 0, 0.9)";
  } else {
    interactionHintDiv.style.display = "none";
    const crosshair = document.getElementById("crosshair");
    if (crosshair) crosshair.style.backgroundColor = "rgba(255, 255, 255, 0.8)";
  }
}

// ----------------- STATS ------------------------

const stats = () => {
  if (statsEnable) {
    const stats1 = new Stats();
    stats1.showPanel(0);
    const stats2 = new Stats();
    stats2.showPanel(1);
    stats2.dom.style.cssText = "position:absolute;top:0px;left:80px;";
    const stats3 = new Stats();
    stats3.showPanel(2);
    stats3.dom.style.cssText = "position:absolute;top:0px;left:160px;";
    document.body.appendChild(stats1.dom);
    document.body.appendChild(stats2.dom);
    document.body.appendChild(stats3.dom);

    function statsUpdate() {
      requestAnimationFrame(statsUpdate);
      stats1.update();
      stats2.update();
      stats3.update();
    }
    statsUpdate();
  }
};
stats();
