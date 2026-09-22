# Agentes completos: ElevenLabs y NVIDIA
- [x] A1 NVIDIA TTS y ASR autorizados y verificados contra servicios reales.
  EVIDENCE: TTS HTTP200 Isabela español; ASR gRPC real transcribió frase sintética, parciales y final.
- [x] A2 Interfaz permite conversar con NVIDIA: micrófono PCM → Parakeet → Nemotron/Nebius → Magpie; detecta fin de habla e interrupción.
  EVIDENCE: scripts/voice-agents-live-check.ts NVIDIA FULL_AGENT_LIVE_OK_SYNTHETIC_MIC, prueba con APIs reales.
- [x] A3 Interfaz permite conversar con ElevenLabs Agents completo con SDK y credencial efímera.
  EVIDENCE: scripts/voice-agents-live-check.ts ElevenLabs FULL_AGENT_LIVE_OK_SYNTHETIC_MIC, respuesta posterior a transcripción real.
- [x] A4 Pruebas de cancelación, errores y compilación sin secretos.
  CHECK: npm test && npm run build && echo FULL_VOICE_CHECK_OK
  EXPECT: FULL_VOICE_CHECK_OK
- [x] A5 Navegador y conexión real, comparación humana pendiente identificada.
  EVIDENCE: Chrome con micrófono sintético y APIs reales en ambos sistemas, sin errores JavaScript y sin overflow móvil; falta valoración humana, no se afirma ganador.
- [ ] A6 Revisión Opus.
  EVIDENCE: pending — OAuth vencido confirmado nuevamente. No hay firma ni se fusiona/despliega sobre demo público.
