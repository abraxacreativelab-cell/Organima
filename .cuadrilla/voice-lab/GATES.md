# Gates
- [ ] G1 API streaming y errores comprobados sin red.
  CHECK: node --import tsx --test test/voice-lab.test.ts && echo LAB_TESTS_OK
  EXPECT: LAB_TESTS_OK
- [ ] G2 Compilación y sintaxis válidas.
  CHECK: npm run build && node --check public/voice-lab.js && echo LAB_BUILD_OK
  EXPECT: LAB_BUILD_OK
