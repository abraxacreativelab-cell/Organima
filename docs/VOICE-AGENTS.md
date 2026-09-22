# Comparación de agentes completos

## Uso

Abre http://127.0.0.1:3212 en Chrome, elige ElevenLabs o NVIDIA, pulsa Iniciar conversación y permite el micrófono. Usa audífonos. Pulsa Terminar antes de cambiar de agente. La interfaz no es una muestra grabada: transmite micrófono real, responde y permite interrumpir.

| Sistema | Escucha | Razonamiento | Voz |
|---|---|---|---|
| ElevenLabs Agents | Scribe Realtime y detección de turnos ElevenLabs | Gemini 2.5 Flash | Eleven Flash v2.5 |
| Agente NVIDIA | Parakeet RNNT multilingüe, gRPC en streaming | Nemotron en Nebius, mediante cognition de Organima | Magpie Isabela es-US, PCM progresivo |

Cada sesión conserva sólo su historia conversacional. No integra memorias persistentes, cámaras ni robot. La prueba compara dos sistemas completos con modelos de razonamiento distintos; no atribuye una diferencia a un solo componente.

## Arranque reproducible

Node22 y Python3.11 o posterior. En la raíz del proyecto:

```sh
npm ci
python3.11 -m venv runtime/nvidia-py
runtime/nvidia-py/bin/pip install -r requirements-voice.txt
npm run build
npm run voice:lab
```

El servidor carga `.env` o el archivo señalado por `DOTENV_CONFIG_PATH`. Variables necesarias: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `NVIDIA_API_KEY`, `NVIDIA_TTS_VOICE=Magpie-Multilingual.ES-US.Isabela`, `NEBIUS_API_KEY` y modelos de conversación/atención ya configurados en Organima. Claves en servidor; el navegador ElevenLabs recibe sólo un token efímero.

Servidor sólo en127.0.0.1:3212. NVIDIA usa el intérprete `runtime/nvidia-py/bin/python`, sustituible por `NVIDIA_ASR_PYTHON`; streaming ASR usa función `71203149-d3b7-4460-8231-1be2543a1fca`, TLS grpc.nvcf.nvidia.com:443. Máximo dos sesiones ASR simultáneas, cinco minutos por sesión, audio acotado y cancelación del proceso al cerrar conexión. Para sesiones más largas, termina y vuelve a iniciar.

## Verificación

- Magpie: consulta de voces HTTP200 y síntesis progresiva HTTP200, español Isabela.
- Parakeet: transcripción real de frase sintética en español; parciales y resultado final. Es necesario `max_alternatives=1`: omitirlo produjo finales sin alternativas.
- Prueba de navegador con micrófono sintético y servicios reales en ambos agentes. Entrada, respuesta y audio confirmados, sin errores JavaScript. No equivale a una comparación estadística ni a experiencia humana validada.
- Tests offline: `npm test`, `runtime/nvidia-py/bin/python test/asr-bridge.test.py`, `npm run build`.
- Prueba real opt-in: `RUN_LIVE_VOICE_CHECK=1 VOICE_CHECK_PROVIDER=nvidia node --import tsx scripts/voice-agents-live-check.ts`; cambiar proveedor a `elevenlabs`. Requiere servidor activo y `runtime/fake-microphone.wav` (audio sintético local, no versionado). Consume APIs reales, no corre en CI.

La tabla estima última actividad de voz → inicio de respuesta. Micrófono con umbral de energía; NVIDIA usa tiempo programado de reproducción y ElevenLabs actividad del audio de salida. No es instrumentación acústica calibrada. Se excluye el saludo y se etiquetan interrupciones. Los modelos alojados pueden variar de latencia entre intentos.

DeepSeek construyó el puente ASR; el arquitecto integró, corrigió y verificó contratos y flujo real. La revisión de Opus sigue pendiente por sesión OAuth vencida; no se fusiona ni despliega sobre la aplicación pública con esa revisión pendiente.
