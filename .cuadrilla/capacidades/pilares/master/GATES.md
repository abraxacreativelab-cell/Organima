- [x] G1 Comportamiento y errores del pilar.
  CHECK: node --import tsx --test test/master.test.ts && echo MASTER_OK
  EXPECT: MASTER_OK
- [x] G2 Análisis de código del pilar.
  CHECK: npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext src/master.ts && echo CODE_OK
  EXPECT: CODE_OK
