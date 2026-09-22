# Organima — resultados de la primera construcción digital

- [x] G1 Arquitectura, contratos, decisiones y guía humana de robótica documentados.
  EVIDENCE: Arquitectura, contratos, decisiones y docs/HARDWARE-CLAUDE-PROMPT.md revisados; inventario físico pendiente explícito.
- [x] G2 Memoria reconstruible y aislamiento de contextos pasan pruebas de reinicio, duplicados y antigüedad.
  EVIDENCE: Pruebas test/memory.test.ts reejecutadas; reconstrucción, duplicados y antigüedad verificadas.
- [x] G3 Adaptadores NVIDIA/Nebius, atención y Tavily validados por contrato; llamadas reales documentadas por separado.
  EVIDENCE: Pruebas de contratos pasan. Recorrido HTTP live local completó NVIDIA, Tavily, visión y audio; docs/VALIDATION.md distingue alcance.
- [x] G4 Robot simulado acepta objetivos, cancela y exige verificación independiente; hardware señalado pendiente.
  EVIDENCE: Pruebas test/robot.test.ts y recorrido Chrome: accepted a awaiting_verification a verified; parada invalida decisiones pendientes.
- [x] G5 Interfaz y API integradas funcionan con escenarios reproducibles y estado honesto de proveedores.
  EVIDENCE: Compilación completa y scripts/browser-check.ts pasan en Chrome escritorio y móvil; sin errores de página ni desbordamiento.
- [ ] G6 Repositorio público sin secretos, instrucciones reproducibles y demo accesible.
  EVIDENCE: pending
- [ ] G7 DeepSeek construye, Opus 5 revisa y el arquitecto vuelve a ejecutar las pruebas.
  EVIDENCE: Los siete pilares recibieron aprobación de Opus 5 tras correcciones. Arquitecto repitió gates y suite; revisión de integración final en curso.
