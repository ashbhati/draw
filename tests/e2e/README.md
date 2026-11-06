# Browser test notes

When a drawing tool is active, Excalidraw's style panel overlays the left side of the canvas (about 200 CSS pixels). Browser tests that draw with the pointer should start to the right of that panel; points under it may not reach the canvas.

The supplied chalkboard reference is stored at `docs/reference/specification-implementation-validation.png`. Its editable V1 reconstruction is `tests/fixtures/specification-implementation-validation.draw` and is exercised by the reference fixture flow in `draw.spec.ts`.
