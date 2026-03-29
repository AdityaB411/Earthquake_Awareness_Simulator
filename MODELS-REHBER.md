# 3D Model Rehberi (Deprem Simulasyonu)

Bu rehber, deprem senaryosunda kullanilan 3D modelleri nasil temin edip projeye ekleyeceginizi aciklar.

## Model Dosya Yapisi

Tum modelleri `assets/3D/` klasorune GLB formatinda kaydedin:

```
assets/
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

## Model Kaynaklari

Ucretsiz ve lisansli modeller icin su kaynaklari kullanilabilir:
- Sketchfab (indirilebilir GLB/GLTF modeller)
- Poly Pizza (dusuk poly, performans dostu)
- Quaternius (oyun varliklari)

Model indirirken lisans kosullarini kontrol edin.

## Format Donusumu

Model GLB degilse, Blender ile donusturun:
1. `File > Import` ile modeli ice aktar
2. `File > Export > glTF 2.0 (.glb/.gltf)` sec
3. `assets/3D/` klasorune kaydet

## Model Ayarlari (main.js)

Pozisyon, olcek ve rotasyon degerlerini `REALISTIC_MODELS` nesnesinden ayarlayabilirsiniz.
Model bulunamazsa otomatik olarak basit geometriler kullanilir.
