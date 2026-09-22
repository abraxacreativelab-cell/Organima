- [ ] G1 Comportamiento y errores del pilar.
  CHECK: node --import tsx --test test/voice.test.ts && echo VOZ_OK
  EXPECT: VOZ_OK
- [ ] G2 Análisis de código del pilar.
  CHECK: npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext src/voice.ts && echo CODE_OK
  EXPECT: CODE_OK
