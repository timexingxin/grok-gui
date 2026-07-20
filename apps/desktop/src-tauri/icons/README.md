# Tauri icons

The canonical source icon is `source-1024.png`. To regenerate the bundle
assets after changing it, run:

```bash
# from the repo root
npx tauri icon ./apps/desktop/src-tauri/icons/source-1024.png \
  -o ./apps/desktop/src-tauri/icons
```

That will generate every required size (32x32.png, 128x128.png,
128x128@2x.png, icon.icns, icon.ico) from a single 1024x1024 source PNG.

`source-1024.png` contains the final opaque, rounded-square Grok Build icon.
