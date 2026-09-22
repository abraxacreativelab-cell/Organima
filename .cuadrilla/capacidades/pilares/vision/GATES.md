- [x] G1 Comportamiento y errores del pilar.
  CHECK: node --import tsx --test test/vision.test.ts && echo VISION_OK
  EXPECT: VISION_OK
- [x] G2 Análisis de código del pilar.
  CHECK: node --check public/vision.js && echo CODE_OK
  EXPECT: CODE_OK
