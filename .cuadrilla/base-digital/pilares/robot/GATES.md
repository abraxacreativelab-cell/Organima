# Verificación robot
- [x] G1 Contrato y fallos del pilar verificados.
  CHECK: node --import tsx --test test/robot.test.ts && echo PILLAR_OK
  EXPECT: PILLAR_OK
- [x] G2 Tipos del pilar válidos.
  CHECK: npm run check && echo TYPES_OK
  EXPECT: TYPES_OK
