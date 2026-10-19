// Three JS Modules
import * as THREE from "three";

import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
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
let isLocked = false;
let currentInteractable = null;
let interactionHintDiv;
let handsGroup;
let shelterZone;
let coverTarget = null;
let awaitingExit = false;
const noCoverZones = [];

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
  if (object.name === "Door") {
    toggleDoor();
    return;
  }

  if (object.name === "shelterZone") {
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
  if (!controls.isLocked) return;

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
}

function updateRumble(intensity) {
  if (!rumbleGain || !rumbleContext) return;
  if (rumbleContext.state === "suspended") {
    rumbleContext.resume();
  }
  const targetGain = Math.min(0.12, 0.02 + intensity * 0.1);
  rumbleGain.gain.setTargetAtTime(targetGain, rumbleContext.currentTime, 0.05);
}

function stopRumble() {
  if (!rumbleGain || !rumbleContext) return;
  rumbleGain.gain.setTargetAtTime(0.0, rumbleContext.currentTime, 0.08);
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
      () => {
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
const groundPlaneY = -0.05;

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function buildQuakeTimeline() {
  quakeTimeline.length = 0;
  totalQuakeDuration = 0;

  const mainStart = 2.0;
  const mainMagnitude = randomRange(5.9, 7.9);
  const mainDuration = randomRange(12, 24);

  quakeTimeline.push({
    start: mainStart,
    magnitude: mainMagnitude,
    duration: mainDuration,
    label: "main",
  });

  totalQuakeDuration += mainDuration;

  const aftershockCount = Math.floor(randomRange(2, 4));
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
}

function getMagnitudeScale(magnitude) {
  const normalized = (magnitude - 4.0) / 4.0;
  const scaled = normalized * 1.1 + 0.15;
  return THREE.MathUtils.clamp(scaled, 0.3, 1.1);
}

function startQuake(event) {
  activeQuake = {
    start: event.start,
    duration: event.duration,
    magnitude: event.magnitude,
    label: event.label,
    phase: Math.random() * Math.PI * 2,
    waveFrequency: randomRange(0.8, 1.8),
    waveSpeed: randomRange(1.5, 3.5),
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
  const ramp = Math.min(elapsed / 2.0, 1.0);
  const fade = Math.min(timeLeft / 2.5, 1.0);
  const envelope = ramp * fade;
  const wave =
    0.6 +
    0.4 *
      Math.sin(elapsed * quake.waveFrequency * Math.PI * 2 + quake.phase);
  const noise = 0.85 + 0.3 * Math.sin(elapsed * quake.waveSpeed + quake.phase);

  return envelope * wave * noise * getMagnitudeScale(quake.magnitude);
}

function updateEarthquake(delta) {
  if (scenarioEnded) return;

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
    applyObjectShake(intensity, scenarioElapsed, delta);
    updateRumble(intensity);

    if (coverActive) {
      coverTimeTotal += delta;
    }
  } else {
    relaxObjects(delta);
  }

  updateCoverState();

  if (timerStarted && !activeQuake && quakeTimeline.length === 0) {
    if (!awaitingExit) {
      awaitingExit = true;
      coverActive = false;
      coverTarget = null;
      showMessage("Shaking has stopped. Check for hazards, then use the exit when safe.", 5000);
      logDecision("exit_instruction", "Exit guidance shown after shaking stopped");
    }

    if (camera.position.z > 3.0) {
      endScenario("success");
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

function registerPhysicsObject(object, options = {}) {
  if (!object) return;

  const box = new THREE.Box3().setFromObject(object);
  const basePosition = object.position.clone();
  const baseRotation = object.rotation.clone();
  const baseMinOffset = basePosition.y - box.min.y;

  object.userData.physics = {
    mass: options.mass ?? 5,
    stability: options.stability ?? 0.6,
    allowTopple: options.allowTopple ?? true,
    label: options.label ?? object.name ?? "Object",
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
    seed: Math.random() * Math.PI * 2,
  };

  physicsObjects.push(object);
}

function applyObjectShake(intensity, time, delta) {
  physicsObjects.forEach((object) => {
    const data = object.userData.physics;
    if (!data) return;

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

    const massFactor = 1 / Math.max(1.0, data.mass);
    const shakeStrength = intensity * massFactor * 2.1;
    const t = time + data.seed;

    data.shakeOffset.set(
      Math.sin(t * 7.0) * 0.03 * shakeStrength,
      Math.sin(t * 11.0) * 0.02 * shakeStrength,
      Math.cos(t * 9.0) * 0.03 * shakeStrength
    );
    data.shakeRotation.set(
      Math.sin(t * 6.0) * 0.03 * shakeStrength,
      Math.cos(t * 5.0) * 0.02 * shakeStrength,
      Math.sin(t * 8.0) * 0.03 * shakeStrength
    );

    object.position.add(data.shakeOffset);
    object.rotation.x += data.shakeRotation.x;
    object.rotation.y += data.shakeRotation.y;
    object.rotation.z += data.shakeRotation.z;

    const toppleRisk = intensity * (1 - data.stability);
    const toppleChance = 0.012 + toppleRisk * 0.08;
    if (data.allowTopple && toppleRisk > 0.48 && Math.random() < toppleChance) {
      data.toppled = true;
      data.velocity.set(
        (Math.random() - 0.5) * 0.6,
        0,
        (Math.random() - 0.5) * 0.6
      );
      data.rotationVelocity.set(
        (Math.random() + 0.2) * 1.2,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.6
      );
      logDecision("object_toppled", `${data.label} devrildi`);
    }

    applyDamage(object, data, intensity);
  });
}

function updateToppledObject(object, data, delta) {
  const gravity = -9.0;
  data.velocity.y += gravity * delta;
  data.velocity.x *= 0.9;
  data.velocity.z *= 0.9;
  object.position.addScaledVector(data.velocity, delta);

  object.rotation.x += data.rotationVelocity.x * delta;
  object.rotation.y += data.rotationVelocity.y * delta;
  object.rotation.z += data.rotationVelocity.z * delta;

  const targetY = groundPlaneY + data.baseMinOffset;
  if (object.position.y <= targetY) {
    object.position.y = targetY;
    data.velocity.set(0, 0, 0);
    data.rotationVelocity.multiplyScalar(0.2);
  }
}

function relaxObjects(delta) {
  physicsObjects.forEach((object) => {
    const data = object.userData.physics;
    if (!data) return;

    if (data.toppled) return;

    object.position.lerp(data.basePosition, delta * 2.5);
    object.rotation.x = THREE.MathUtils.lerp(
      object.rotation.x,
      data.baseRotation.x,
      delta * 2.5
    );
    object.rotation.y = THREE.MathUtils.lerp(
      object.rotation.y,
      data.baseRotation.y,
      delta * 2.5
    );
    object.rotation.z = THREE.MathUtils.lerp(
      object.rotation.z,
      data.baseRotation.z,
      delta * 2.5
    );
  });
}

function applyDamage(object, data, intensity) {
  if (intensity < 0.55 || data.broken) return;

  const chance = intensity * (1 - data.stability) * 0.02;
  if (Math.random() < chance) {
    data.damaged = Math.min(1, data.damaged + intensity * 0.15);

    if (data.damaged > 0.6 && !data.broken) {
      data.broken = true;
      markObjectDamaged(object);
      logDecision("object_damaged", `${data.label} hasar gordu`);
    }
  }
}

function markObjectDamaged(object) {
  object.traverse((child) => {
    if (!child.isMesh || !child.material) return;
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
    showMessage("You left the cover area.", 1000);
  }
}

function isCameraInShelter() {
  if (!shelterZone) return false;
  const box = new THREE.Box3().setFromObject(shelterZone);
  if (!box.containsPoint(camera.position)) return false;
  const reason = getNoCoverReason();
  return !reason;
}

function getNoCoverReason() {
  for (const zone of noCoverZones) {
    if (zone.box.containsPoint(camera.position)) {
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
    coverTarget = new THREE.Vector3(
      camera.position.x,
      EYE_HEIGHT_CROUCH,
      camera.position.z
    );
    camera.position.y = EYE_HEIGHT_CROUCH;

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

  if (responseTime < 2) {
    userScore += 30;
  } else if (responseTime < 5) {
    userScore += 20;
  } else {
    userScore += 10;
  }
}

// ==================== TIMING AND SCORING ====================
let timerStarted = false;
let startTime = 0;
let userScore = 0;
let decisionLog = [];

function logDecision(action, description) {
  decisionLog.push({
    time: Date.now() - startTime,
    action,
    description,
  });
}

function showMessage(message, duration = 4000) {
  const messageDiv = document.getElementById("messageBox");
  if (messageDiv) {
    messageDiv.textContent = message;
    messageDiv.style.display = "block";

    setTimeout(() => {
      messageDiv.style.display = "none";
    }, duration);
  }
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
    statusDiv.textContent = "Shaking has paused; waiting for aftershocks...";
    statusDiv.style.color = "#00d4ff";
    statusDiv.style.borderColor = "#00d4ff";
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
  const coverScore = Math.round(Math.min(1, coverRatio) * 60);
  userScore += coverScore;

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
  timeText.textContent = `Total time: ${totalTime} seconds`;

  let logHTML = "<h4>Decision Log:</h4><ul>";
  decisionLog.forEach((log) => {
    logHTML += `<li>[${(log.time / 1000).toFixed(1)}s] ${log.description}</li>`;
  });
  logHTML += `</ul><p>Objects toppled: ${toppledCount} | Objects damaged: ${damagedCount}</p>`;
  logText.innerHTML = logHTML;

  if (controls) controls.unlock();

  setTimeout(() => {
    try {
      const finalResultText = `${title} - ${text}`;
      exportToCSV(totalTime, userScore, finalResultText, toppledCount, damagedCount);
    } catch (e) {
      console.error("Failed to generate the training report:", e);
    }
  }, 500);
}

function exportToCSV(totalTime, score, resultText, toppledCount, damagedCount) {
  const user = window.userData || {
    name: "Unknown",
    surname: "User",
    startTime: new Date().toLocaleString("en-GB"),
  };

  function formatElapsedTime(seconds) {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const totalSecondsInt = Math.floor(safeSeconds);
    const tenths = Math.floor((safeSeconds - totalSecondsInt) * 10 + 1e-9);

    const mins = Math.floor(totalSecondsInt / 60);
    const secs = totalSecondsInt % 60;

    const mm = String(mins).padStart(2, "0");
    const ss = String(secs).padStart(2, "0");
    return `${mm}:${ss}.${tenths}`;
  }

  let csvContent = "\uFEFF";
  csvContent += "EARTHQUAKE TRAINING SIMULATION REPORT\n";
  csvContent += "--------------------------------\n";
  csvContent += `Name;${user.name} ${user.surname}\n`;
  csvContent += `Date;${user.startTime}\n`;
  csvContent += `Total time;${totalTime} seconds\n`;
  csvContent += `Score;${score}\n`;
  csvContent += `Objects toppled;${toppledCount}\n`;
  csvContent += `Objects damaged;${damagedCount}\n`;
  csvContent += `Result;${resultText.replace(/\n/g, " ")}\n\n`;

  csvContent += "--------------------------------\n";
  csvContent += "DETAILED DECISION LOG\n";
  csvContent += "Time (mm:ss.s);Action;Description\n";

  decisionLog.forEach((log) => {
    const timeSeconds = typeof log.time === "number" ? log.time / 1000 : Number(log.time);
    const timeFormatted = formatElapsedTime(timeSeconds);
    const time = `'${timeFormatted}`;
    const desc = log.description.replace(/;/g, ",");
    csvContent += `${time};${log.action};${desc}\n`;
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  const dateStr = new Date().toISOString().slice(0, 10);
  link.setAttribute("href", url);
  link.setAttribute("download", `Earthquake_Training_Report_${user.name}_${user.surname}_${dateStr}.csv`);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
  await init();
  createProceduralHands();
  animate();
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

  await createRoom();

  hdriLoader.load("Env.hdr", function (texture) {
    if (!ENV_REFLECTION_ENABLED) return;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = texture;
  });
  if (!ENV_REFLECTION_ENABLED) scene.environment = null;

  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 8, 20);

  renderer = new THREE.WebGLRenderer({ antialias: antialiasing });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = 1;
  container.appendChild(renderer.domElement);

  controls = new PointerLockControls(camera, document.body);

  controls.addEventListener("lock", function () {
    isLocked = true;
  });

  controls.addEventListener("unlock", function () {
    isLocked = false;
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  window.addEventListener("resize", onWindowResize);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0xe8f4fc, 0x8b7355, 0.5);
  scene.add(hemiLight);

  const ceilingLight1 = new THREE.PointLight(0xffffee, 2.0, 10);
  ceilingLight1.position.set(-1, 2.8, -1);
  ceilingLight1.castShadow = true;
  scene.add(ceilingLight1);

  const ceilingLight2 = new THREE.PointLight(0xffffee, 2.0, 10);
  ceilingLight2.position.set(1, 2.8, 1);
  ceilingLight2.castShadow = true;
  scene.add(ceilingLight2);

  const fillDir = new THREE.DirectionalLight(0xffffff, 0.8);
  fillDir.position.set(2, 4, 2);
  scene.add(fillDir);

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

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);

  render();
}

function render() {
  if (composer) composer.render();
  else renderer.render(scene, camera);
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
  });

  createShelterZoneForObject(desk);

  let monitor = null;
  let screen = null;
  let keyboard = null;
  let computerMouse = null;

  if (loadedModels.monitor) {
    monitor = loadedModels.monitor;
    monitor.name = "monitor";
    room.add(monitor);
  } else {
    const monitorData = createFallbackMonitor();
    monitor = monitorData.monitor;
    screen = monitorData.screen;
    keyboard = monitorData.keyboard;
    computerMouse = monitorData.mouse;
  }

  if (loadedModels.keyboard) {
    keyboard = loadedModels.keyboard;
    keyboard.name = "keyboard";
    room.add(keyboard);
  }

  if (loadedModels.mouse) {
    computerMouse = loadedModels.mouse;
    computerMouse.name = "mouse";
    room.add(computerMouse);
  }

  registerPhysicsObject(monitor, {
    mass: 3.5,
    stability: 0.2,
    allowTopple: true,
    label: "Monitor",
  });
  registerPhysicsObject(keyboard, {
    mass: 1.8,
    stability: 0.4,
    allowTopple: true,
    label: "Keyboard",
  });
  registerPhysicsObject(computerMouse, {
    mass: 1.1,
    stability: 0.35,
    allowTopple: true,
    label: "Mouse",
  });

  if (loadedModels.chair) {
    room.add(loadedModels.chair);
    registerPhysicsObject(loadedModels.chair, {
      mass: 12,
      stability: 0.6,
      allowTopple: true,
      label: "Office chair",
    });
  } else {
    const fallbackChair = createFallbackChair();
    registerPhysicsObject(fallbackChair, {
      mass: 10,
      stability: 0.55,
      allowTopple: true,
      label: "Chair",
    });
  }

  if (loadedModels.guestChair1) {
    room.add(loadedModels.guestChair1);
    registerPhysicsObject(loadedModels.guestChair1, {
      mass: 8,
      stability: 0.5,
      allowTopple: true,
      label: "Guest chair",
    });
  }

  if (loadedModels.guestChair2) {
    room.add(loadedModels.guestChair2);
    registerPhysicsObject(loadedModels.guestChair2, {
      mass: 8,
      stability: 0.5,
      allowTopple: true,
      label: "Guest chair",
    });
  }

  if (loadedModels.plant) {
    room.add(loadedModels.plant);
    registerPhysicsObject(loadedModels.plant, {
      mass: 3.5,
      stability: 0.25,
      allowTopple: true,
      label: "Plant",
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
    });
  } else {
    const fallbackHeater = createFallbackHeater();
    heater = fallbackHeater;
    registerPhysicsObject(fallbackHeater, {
      mass: 10,
      stability: 0.55,
      allowTopple: true,
      label: "Heater",
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
  const deskGeometry = new THREE.BoxGeometry(1.5, 0.05, 0.8);
  const deskMaterial = new THREE.MeshStandardMaterial({
    color: 0x5c4033,
    roughness: 0.7,
    metalness: 0.1,
  });
  const desk = new THREE.Mesh(deskGeometry, deskMaterial);
  desk.position.set(0, 0.75, 0);
  desk.castShadow = true;
  desk.receiveShadow = true;
  room.add(desk);

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
    room.add(leg);
  });

  return desk;
}

function createFallbackMonitor() {
  const monitorGeometry = new THREE.BoxGeometry(0.55, 0.38, 0.04);
  const monitorMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.2,
    metalness: 0.7,
  });
  const monitor = new THREE.Mesh(monitorGeometry, monitorMaterial);
  monitor.position.set(0, 0.98, -0.18);
  monitor.rotation.x = -0.08;
  monitor.castShadow = true;
  monitor.receiveShadow = true;
  monitor.name = "monitor";
  room.add(monitor);

  const screenGeometry = new THREE.BoxGeometry(0.5, 0.32, 0.01);
  const screenMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a8cff,
    emissive: 0x0055aa,
    emissiveIntensity: 0.6,
    roughness: 0.05,
    metalness: 0.1,
  });
  const screen = new THREE.Mesh(screenGeometry, screenMaterial);
  screen.position.set(0, 0.98, -0.155);
  screen.rotation.x = -0.08;
  room.add(screen);

  const neckGeometry = new THREE.BoxGeometry(0.06, 0.15, 0.06);
  const standMaterial = new THREE.MeshStandardMaterial({
    color: 0x222222,
    roughness: 0.4,
    metalness: 0.6,
  });
  const neck = new THREE.Mesh(neckGeometry, standMaterial);
  neck.position.set(0, 0.855, -0.18);
  room.add(neck);

  const baseGeometry = new THREE.CylinderGeometry(0.12, 0.14, 0.02, 24);
  const base = new THREE.Mesh(baseGeometry, standMaterial);
  base.position.set(0, 0.785, -0.18);
  room.add(base);

  const keyboardGeometry = new THREE.BoxGeometry(0.42, 0.015, 0.14);
  const keyboardMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.6,
    metalness: 0.3,
  });
  const keyboard = new THREE.Mesh(keyboardGeometry, keyboardMaterial);
  keyboard.position.set(0, 0.785, 0.12);
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
  computerMouse.position.set(0.28, 0.79, 0.15);
  computerMouse.castShadow = true;
  room.add(computerMouse);

  return { monitor, screen, keyboard, mouse: computerMouse };
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
  const heaterGeometry = new THREE.CylinderGeometry(0.16, 0.19, 0.38, 20);
  const heaterMaterial = new THREE.MeshStandardMaterial({
    color: 0x6e6e6e,
    roughness: 0.55,
    metalness: 0.35,
  });
  const heater = new THREE.Mesh(heaterGeometry, heaterMaterial);
  heater.position.set(0.35, 0.19, 0.15);
  heater.castShadow = true;
  heater.receiveShadow = true;
  heater.name = "heater";
  room.add(heater);

  const rimGeometry = new THREE.TorusGeometry(0.17, 0.015, 8, 24);
  const rimMaterial = new THREE.MeshStandardMaterial({
    color: 0x505050,
    roughness: 0.4,
    metalness: 0.6,
  });
  const rim = new THREE.Mesh(rimGeometry, rimMaterial);
  rim.position.set(0.35, 0.38, 0.15);
  rim.rotation.x = Math.PI / 2;
  room.add(rim);

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
  requestAnimationFrame(animate);

  deltaTime = clock.getDelta();

  if (controls && controls.update) controls.update();
  controls.dampingFactor = guiObject.value4;

  updateFirstPersonMovement(deltaTime);
  updateInteraction();

  if (!guiObject.pauseBoolean) {
    updateEarthquake(deltaTime);
  }

  updateHands();

  updateStatus();

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

// ----------------- ROOM TOUR ------------------------
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

  initRumbleAudio();
  buildQuakeTimeline();

  scenarioStartTime = Date.now();
  startTime = scenarioStartTime;
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

    if (controls && !controls.isLocked) {
      controls.lock();
    }

    const crosshair = document.getElementById("crosshair");
    if (crosshair) crosshair.style.display = "block";
  }, 1500);
}

function validateAndStart() {
  const nameInput = document.getElementById("userName");
  const surnameInput = document.getElementById("userSurname");

  const name = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "Unknown";
  const surname = surnameInput && surnameInput.value.trim() ? surnameInput.value.trim() : "User";

  window.userData = {
    name,
    surname,
    startTime: new Date().toLocaleString("en-GB"),
  };

  const controlsIntro = document.getElementById("controls-intro");
  if (controlsIntro) {
    controlsIntro.style.display = "none";
  }

  runRoomTour();
}

window.earthquakeSimulation = {
  startScenario,
  runRoomTour,
};

window.validateAndStart = validateAndStart;

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
  if (!controls.isLocked) {
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
