# Earthquake Awareness Simulator

A laptop-friendly, browser-based 3D earthquake-preparedness training prototype adapted from [EarthquakeSim by Furkan Koykiran](https://github.com/furkankoykiran/EarthquakeSim). It uses Three.js and Vite to let a user explore an office, experience a simulated earthquake sequence, practise taking cover, and review a score and decision log.

> **Current status:** this repository is a desktop 3D/WebGL prototype. WebXR support, thumbstick locomotion, and controller pointing/selection have been added on the `feature/webxr-foundation` branch; they still need testing on a compatible immersive browser/headset. The main branch remains the current desktop baseline until the feature branch is reviewed and merged. The earthquake motion and object-toppling rules are illustrative game logic, not a scientific ground-motion or structural-engineering model. Use the app for education and demonstration, not as a substitute for official emergency guidance or certified training.

## Current features

- First-person desktop navigation with WASD and mouse pointer lock
- 3D office environment with furniture and fallback models
- Randomized main-shock and aftershock sequence
- Visual camera/object shaking and heuristic object-toppling/damage cues
- Take-cover interaction with response-time and cover-duration scoring
- End-of-run summary and decision log\n- Optional three-question post-scenario safety knowledge check with explanations\n- User-triggered CSV report download including the knowledge-check score
- Local browser-only operation; no server-side account or training-data storage is implemented

## Requirements

- Node.js 18 or newer (recommended)
- npm 9 or newer

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally http://localhost:5173).

## Build and preview

```bash
npm run build
npm run preview
```

The production build is generated in `dist/`.

## Docker

```bash
docker compose up --build
```

The container serves the app on port 8080.

## Project structure

- `index.html`: interface, instructions, controls, and results screen
- `main.js`: Three.js scene, movement, earthquake timeline, object effects, cover logic, scoring, and CSV export
- `styles/style.css`: interface styling
- `public/assets/3D/`: GLB models
- `public/assets/hdri/`: environment maps
- `vite.config.js`: development server and asset base settings
- `.github/workflows/pages.yml`: GitHub Pages build/deployment workflow

## Known limitations to address before course submission

1. **WebXR needs end-to-end validation.** The `feature/webxr-foundation` branch enables Three.js WebXR and adds the standard VR entry button. Basic headset tracking, thumbstick locomotion, and controller-trigger interactions are implemented but remain untested on compatible immersive hardware. Validate the full experience before describing immersive mode as fully functional. Desktop mode remains the supported development baseline.
2. **Safety behaviour needs review.** The current cover zone is an invisible volume around the desk; the interaction mainly crouches the camera and locks movement rather than simulating a verified Drop, Cover, and Hold On action. The scenario should be checked against official safety guidance before being used as instructional material.
3. **Physics are approximate.** Event magnitudes/durations and object topple/damage events are generated procedurally. They should not be presented as real earthquake predictions or scientifically accurate structural responses.
4. **Assessment is educational.** The short knowledge check reinforces safety guidance but is not a validated readiness test or certification.\n5. **Scoring is heuristic.** The score represents actions inside this prototype, not a validated measure of real-world readiness. The score display reflects a maximum of 180 points under the current scoring rules.
6. **Asset attribution should be verified.** The code is MIT-licensed, but confirm the licences/attributions for each bundled 3D model and environment asset before redistributing the project publicly.

## Suggested course-project improvements

- Validate WebXR with an explicit desktop fallback
- Teach and assess Drop, Cover, and Hold On with clear in-simulation explanations
- Compare pre-test and post-test results in a future iteration so learning outcomes can be measured
- Provide a transparent scoring rubric and scenario debrief
- Test keyboard controls, model loading, report export, and keyboard accessibility on the target laptop/browser

## Upstream project and license

This fork is based on [EarthquakeSim](https://github.com/furkankoykiran/EarthquakeSim). The original repository's MIT license is retained in `LICENSE`; preserve its copyright and license notice when redistributing substantial portions of the code. Review the separate licences of bundled media assets as well.
