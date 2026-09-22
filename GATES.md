# Organima — resultados de la primera construcción digital

- [x] G1 Arquitectura, contratos, decisiones y guía humana de robótica documentados.
  EVIDENCE: Arquitectura, contratos, decisiones y docs/HARDWARE-CLAUDE-PROMPT.md revisados; inventario físico pendiente explícito.
- [x] G2 Memoria reconstruible y aislamiento de contextos pasan pruebas de reinicio, duplicados y antigüedad.
  EVIDENCE: Pruebas test/memory.test.ts reejecutadas; reconstrucción, duplicados y antigüedad verificadas.
  CHECK: node --import tsx --test test/memory.test.ts && echo MEMORY_OK
  EXPECT: MEMORY_OK
- [x] G3 Adaptadores NVIDIA/Nebius, atención y Tavily validados por contrato; llamadas reales documentadas por separado.
  EVIDENCE: Pruebas de contratos pasan. Recorrido HTTP live local completó NVIDIA, Tavily, visión y audio; docs/VALIDATION.md distingue alcance.
  CHECK: node --import tsx --test test/cognition.test.ts test/master.test.ts test/voice.test.ts test/vision.test.ts && echo PROVIDERS_OK
  EXPECT: PROVIDERS_OK
- [x] G4 Robot simulado acepta objetivos, cancela y exige verificación independiente; hardware señalado pendiente.
  EVIDENCE: Pruebas test/robot.test.ts y recorrido Chrome: accepted a awaiting_verification a verified; parada invalida decisiones pendientes.
  CHECK: node --import tsx --test test/robot.test.ts test/integration.test.ts && echo ROBOT_OK
  EXPECT: ROBOT_OK
- [x] G5 Interfaz y API integradas funcionan con escenarios reproducibles y estado honesto de proveedores.
  EVIDENCE: Compilación completa y scripts/browser-check.ts pasan en Chrome escritorio y móvil; sin errores de página ni desbordamiento.
  CHECK: npm run build && npm run test:browser && echo INTEGRATION_OK
  EXPECT: INTEGRATION_OK
- [ ] G6 Repositorio público sin secretos, instrucciones reproducibles y demo accesible.
  EVIDENCE: pending
  CHECK: node --import tsx scripts/secret-check.ts && curl --fail --silent https://organima.187-77-9-8.sslip.io/api/health && echo PUBLIC_OK
  EXPECT: PUBLIC_OK
- [x] G7 DeepSeek construye, Opus 5 revisa y el arquitecto vuelve a ejecutar las pruebas.
  EVIDENCE: Los siete pilares y la integración recibieron aprobación de Opus 5. Ver docs/INTEGRATION-REVIEW.md. Arquitecto repitió suite y navegador; GitHub CI con Chromium terminó correctamente.
