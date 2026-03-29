# EarthquakeSim

A web-based 3D earthquake emergency training simulator for office environments. The experience focuses on quick decision-making, take-cover behavior, aftershock awareness, and object stability under seismic motion.

## About

EarthquakeSim is a browser-based training scene built with Three.js. It simulates shaking, object topple risk, and a simple scoring/reporting flow to reinforce safe responses during an earthquake.

## Features

- Camera shake with adjustable intensity
- Object shake, topple, and damage cues
- Aftershock timeline and randomized magnitude
- Take-cover interaction with scoring
- CSV training report export
- FPS navigation with pointer lock

## Tech Stack

- Three.js
- Vite
- Vanilla JavaScript + HTML + CSS

## Getting Started

```bash
npm install
npm run dev -- --port 5175
```

Open: http://localhost:5175

## Build and Preview

```bash
npm run build
npm run preview -- --host --port 5175
```

## Docker

```bash
docker compose up --build
```

## Project Structure

- index.html: UI and scenario copy
- main.js: core simulation logic
- styles/style.css: UI styling
- assets/3D: 3D models used by the scene
- assets/hdri: environment lighting

## Safety Note

This simulator is for training and awareness only. It is not a substitute for certified safety training or official emergency procedures.

## License

MIT
