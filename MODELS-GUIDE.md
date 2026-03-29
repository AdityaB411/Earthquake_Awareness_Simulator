# 3D Model Guide (EarthquakeSim)

This guide explains how to source, convert, and integrate 3D models used in the EarthquakeSim scene.

## Model File Structure

All models should be stored in `public/assets/3D/` as GLB files:

```
public/
└── assets/
    └── 3D/
        ├── office_desk.glb
        ├── computer_monitor.glb
        ├── mouse_and_keyboard.glb
        ├── office_chair.glb
        ├── chair.glb
        ├── majesty_palm_plant.glb
        ├── electrical_panel.glb
        ├── exit_box.glb
        └── simple_heater.glb
```

## Recommended Sources

- Sketchfab (downloadable GLB/GLTF)
- Poly Pizza (low-poly, performance friendly)
- Quaternius (game-ready assets)

Always review license terms before use.

## Format Conversion (Blender)

If the model is not GLB:
1. `File > Import` and select the model
2. `File > Export > glTF 2.0 (.glb/.gltf)`
3. Save into `public/assets/3D/`

## Model Placement (main.js)

Positions, scales, and rotations are defined in the `REALISTIC_MODELS` object.
If a model is missing, a fallback geometry is used instead.

## Performance Notes

- Prefer low-poly meshes for real-time use
- Keep textures at 1024x1024 or smaller
- Optimize large models before importing
