# Comparación conversacional de voz
- [x] G1 Hablar envía automáticamente; audio se reproduce progresivamente; interrupción invalida audio y respuestas anteriores.
  EVIDENCE: scripts/voice-lab-browser-check.ts PASS con reconocimiento y proveedores simulados; no acredita micrófono real.
- [x] G2 Adaptadores ElevenLabs y NVIDIA probados por contrato y suite integrada.
  CHECK: npm test && npm run build && echo LAB_INTEGRATION_OK
  EXPECT: LAB_INTEGRATION_OK
  EVIDENCE: npm test, npm run build y navegador comprobados; no certifica disponibilidad NVIDIA.
- [ ] G3 ElevenLabs real accesible desde laboratorio local; credenciales fuera del navegador.
  EVIDENCE: pending
- [ ] G4 NVIDIA real accesible y conversación A/B medida con usuario.
  EVIDENCE: pending — falta NVIDIA_API_KEY y voz validada. No aprobado por prueba sin red.
- [ ] G5 Revisión independiente Opus y comprobación del arquitecto.
  EVIDENCE: pending — Claude OAuth session expired and could not be refreshed; no firma Opus.

## Alcance corregido por el usuario
- [ ] G6 Conversación real mediante ElevenLabs Agents completo (incluye escucha, turnos, voz e interrupciones).
  EVIDENCE: pending
- [ ] G7 Conversación con agente NVIDIA completo y comparación percibida por usuario.
  EVIDENCE: pending — falta acceso NVIDIA Speech. G1–G4 TTS no sustituyen G6–G7.
