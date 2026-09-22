# Alcance actual: agentes conversacionales completos

El usuario eligió **ElevenLabs Agents completo vs. agente NVIDIA completo**. El laboratorio TTS descrito debajo es diagnóstico auxiliar y NO satisface esa comparación por sí solo.

## ElevenLabs Agents

Agente independiente: `agent_5401m355308bfa4sbdm9m7xb2w5g`.
[Abre el agente en ElevenLabs](https://elevenlabs.io/app/agents/agents/agent_5401m355308bfa4sbdm9m7xb2w5g).
Pulsa la prueba de conversación del agente y permite el micrófono. No modifica otros agentes.

Cadena: Scribe Realtime → Gemini 2.5 Flash → Eleven Flash v2.5, voz mexicana configurada en Organima. Detección de turnos e interrupciones a cargo de ElevenLabs Agents. Autenticación obligatoria; sin grabación de voz, transcripciones con retención de un día. Reprovisionamiento idempotente por nombre: `node scripts/provision-voice-agent.mjs` con `.env` del proyecto.

Verificación real realizada: obtención de URL firmada HTTP200, sesión WebSocket conectada y audio del agente recibido. Esto NO es una medición del micrófono ni una conversación evaluada por Santiago.

## NVIDIA

Falta NVIDIA_API_KEY y validar los endpoints de ASR/TTS en español de esa cuenta. Nebius Token Factory se usa para el LLM, pero su clave no autoriza NVIDIA Speech. La comparación completa queda pendiente; el navegador Web Speech del diagnóstico auxiliar no se presentará como reconocimiento NVIDIA.

La prueba compara la experiencia completa de dos sistemas. Por ello puede cambiar el modelo de razonamiento. No permite atribuir por sí sola una diferencia al sintetizador. Ambas variantes deben recibir las mismas preguntas, personalidad y contexto inicial. Esta primera prueba no incorpora grafo, GitHub ni actuadores de producción.

## Revisión

DeepSeek construyó el diagnóstico auxiliar; el arquitecto corrigió cancelación y métricas, y verificó pruebas. Opus no pudo iniciar por OAuth vencido. No hay firma Opus y no se ha desplegado esto sobre la app pública.

---

# Laboratorio conversacional A/B

Página local para **hablar con el agente y medir la latencia real** del viaje completo:
dictado → cerebro → texto→audio → primer sonido. Compara el mismo cerebro (NVIDIA en Nebius, vía
`src/cognition.ts`) y el mismo transcriptor del navegador cambiando **sólo el proveedor de voz**:
ElevenLabs o NVIDIA TTS.

- Página: `public/voice-lab.html` + `public/voice-lab.js`
- Backend: `src/voice-lab.ts`
- Arranque: `src/voice-lab-server.ts`
- Pruebas: `test/voice-lab.test.ts`

No usa la app desplegada, ni el robot, ni la memoria persistida: no lee ni escribe nada de
producción. La historia de la conversación vive en RAM (en el navegador y en la petición).

## Cómo se ejecuta

```bash
# Desde la raíz del checkout. El lanzador pasa DOTENV_CONFIG_PATH apuntando al .env del main;
# este archivo no lee secretos por su cuenta.
npx tsx src/voice-lab-server.ts
# → Laboratorio de voz: http://127.0.0.1:3212
```

Abre `http://127.0.0.1:3212/`. El servidor escucha **sólo en `127.0.0.1`** (no es configurable) y
sirve la página en `/` y sus estáticos desde `public/`.

| Variable | Uso |
|---|---|
| `VOICE_LAB_PORT` | Puerto local; por defecto `3212`. Un valor inválido detiene el arranque. |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | Proveedor ElevenLabs. Sin ambos, queda no disponible. |
| `NVIDIA_API_KEY` / `NVIDIA_TTS_VOICE` | Proveedor NVIDIA TTS. La voz es obligatoria y explícita. |
| `NVIDIA_TTS_BASE_URL` | Override de la base NVCF; debe ser `http(s)`. |
| `VOICE_LAB_TTS_TIMEOUT_MS` | Override del plazo de síntesis (por defecto `30000`). Existe para poder probar el timeout sin esperar 30 s; en operación normal no se toca. |

## Endpoints

Todos bajo `/api/lab`, con cuerpo JSON máximo de **32 KiB**, validación estricta y escritura sólo
desde el servidor.

### `GET /api/lab/status`

```json
{
  "sampleRate": 22050,
  "maxTextChars": 1600,
  "historyLimit": 12,
  "providers": [
    { "id": "elevenlabs", "label": "ElevenLabs", "configured": true },
    { "id": "nvidia", "label": "NVIDIA TTS", "configured": false, "reason": "falta NVIDIA_API_KEY" }
  ]
}
```

Nunca incluye claves ni ids de voz; sólo el motivo legible de por qué un proveedor no está listo.

### `POST /api/lab/turn`

```json
{ "message": "¿qué hora es?", "history": [{ "role": "user", "text": "hola" }] }
```

- `message`: texto no vacío, máximo **1600 caracteres**. Si excede, responde `400` con el campo
  culpable: **nunca se trunca en silencio**.
- `history`: hasta 24 turnos `{role: "user" | "assistant", text}`; se usan **los últimos 12** y se
  convierten a eventos `OrganimaEvent` (`conversation.user` / `conversation.reply`, célula
  `voice-lab`) con snapshot vacío `{version: 0, relations: [], events: []}`.
- Devuelve `{ text, model, mode, brainMs, sources }`, donde `brainMs` es la duración medida en el
  servidor alrededor de `cognition.reply(...)`.
- Al cerebro se le pide brevedad explícitamente (además de su propio prompt): reduce la latencia
  de síntesis sin mentir sobre lo que se midió.

### `POST /api/lab/tts`

```json
{ "provider": "elevenlabs", "text": "Hola, ¿cómo estás?" }
```

Responde un stream PCM crudo con `Content-Type: application/octet-stream` y
`X-Audio-Sample-Rate: 22050`:

- **PCM16LE, mono, 22050 Hz**, retransmitido **mientras llega**. El servidor no acumula el audio
  completo y sólo envía cabeceras cuando ya tiene el primer fragmento real que mandar: un stream
  vacío o un error del proveedor nunca se disfraza de audio.
- Tope duro de **4 MiB**; al excederse se corta la conexión y se aborta la petición al proveedor.
- Plazo único de **30 s** (`VOICE_LAB_TTS_TIMEOUT_MS`) que cubre cabeceras **y** cuerpo.
- Si el cliente se desconecta, se aborta la petición al proveedor. `close()` cancela lo pendiente.

### Proveedores

**ElevenLabs** — `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream?output_format=pcm_22050`,
cabecera `xi-api-key`, cuerpo `{text, model_id: "eleven_flash_v2_5", language_code: "es",
voice_settings: {stability: 0.45, similarity_boost: 0.75}}`. Se admite PCM declarado o `application/octet-stream`; no se reproduce MP3/WAV como PCM.

**NVIDIA TTS** — `POST {NVIDIA_TTS_BASE_URL}/v1/audio/synthesize_online` con
`Authorization: Bearer …` y `FormData`: `text`, `language=es-US`, `voice`, `sample_rate_hz=22050`,
`encoding=LINEAR_PCM`. La base por defecto es el endpoint NVCF hospedado documentado. La respuesta
de NVIDIA puede omitir `content-type`; si declara uno que no es audio, se rechaza.

> El endpoint hospedado de NVIDIA en modo streaming **no está verificado con una cuenta real**. Si
> responde `404`, el laboratorio lo informa con claridad (`nvidia_endpoint_unavailable`) y **no hay
> respaldo automático a ElevenLabs**: el proveedor se elige explícitamente en la página y el
> servidor jamás sustituye uno por otro.

## Seguridad

- Escucha **sólo en `127.0.0.1`**; pensado para un operador local.
- Se rechaza (`403`) cualquier petición con `Origin` distinto del `Host`; no se emiten cabeceras
  CORS ni se atienden preflight.
- Las claves viven **sólo en el servidor** y nunca aparecen en respuestas, estados ni errores. Los
  mensajes de error se recortan y redactan; los cuerpos de error del proveedor nunca se devuelven.
- Todo texto se valida antes de tocar la red; todo fallo externo tiene plazo y manejo explícito.

## Qué mide la tabla de latencias (y qué no)

| Columna | Origen | Honestidad |
|---|---|---|
| fin habla→transcripción | `speechend` del navegador → resultado final del dictado | Sólo si `speechend` ocurrió antes del final; si no, **n/d**. |
| cerebro (servidor) | Duración medida en el servidor alrededor de `reply(...)` | Medición real del backend. |
| TTS primer chunk | Desde que el navegador pide `/api/lab/tts` hasta el primer byte de audio | Medición del cliente. |
| fin habla→primer playback (est.) | Hora estimada de arranque del primer `BufferSource` (reloj de `AudioContext` + margen de 35 ms) menos `speechend` | **Estimación de planificación, no medición acústica.** Sin `speechend` válido se marca n/d. |

- Cuando no hay `speechend` válido, «fin habla→primer playback» queda en **n/d** y las demás
  columnas se miden desde sus propios orígenes (el resultado final del dictado y la petición de
  TTS): nunca se inventa un origen para el playback.

- Los turnos **cancelados o fallidos no entran** a la tabla.
- La tabla conserva las últimas 20 filas, sólo en RAM.
- El cerebro devuelve el texto completo: aquí **no se simula streaming de lenguaje**. Lo que sí
  llega progresivamente es el audio. No se presenta una muestra grabada como conversación.

## Comportamiento de la página

- `Iniciar conversación` abre el micrófono (sólo tras un gesto), usa Web Speech API en `es-MX` con
  `continuous` e `interimResults`, y **envía solo el resultado final**. También hay un campo de
  texto de respaldo para navegadores sin dictado.
- Voz nueva interrumpe la respuesta: se aborta el fetch, se detiene el audio agendado y un contador
  de generación invalida cualquier respuesta tardía.
- Cambiar de proveedor reinicia el contexto de la conversación y cancela lo pendiente.
- `Terminar` cierra el micrófono y cancela. El reconocimiento sólo se reabre tras `onend` si el
  usuario lo habilitó; los errores de permiso detienen todo sin bucle.
- Un proveedor no configurado queda deshabilitado en el selector, con su motivo.
- Se recomienda usar auriculares: el micrófono sigue abierto mientras el agente habla.
- El dictado usa el transcriptor del navegador (Web Speech API); ese audio lo procesa el servicio
  de reconocimiento del navegador, no Organima. La página lo explica al usuario.
- El audio se reproduce por fragmentos (byte impar conservado entre chunks, `int16` → `float`,
  `BufferSource` contiguos desde `currentTime + 80 ms`), sin esperar nunca el cuerpo completo.

## Pruebas

```bash
node --import tsx --test test/voice-lab.test.ts   # suite del laboratorio, sin red externa
npm run build                                     # tsc
node --check public/voice-lab.js                  # sintaxis del cliente
npm test                                          # suite completa del proyecto
```

La suite offline verifica: primer chunk antes de que el productor cierre, contratos exactos de
ElevenLabs y NVIDIA, base NVCF configurable, `404` de NVIDIA sin respaldo, errores sin claves ni
cuerpos, content-type no-audio, Origin distinto del Host, cancelación por desconexión, timeout de
cabeceras y de cuerpo, tope de 4 MiB, límites de entrada, historia acotada, configuración de
proveedores y `close()`.

## Limitaciones conocidas

- **No** se comprobó disponibilidad real de ningún proveedor: sin `ELEVENLABS_API_KEY` ni
  `NVIDIA_API_KEY` no hay evidencia de API real; el modo simulado nunca se presenta como real.
- El endpoint hospedado de NVIDIA en streaming sigue sin verificar (puede responder `404`).
- El rendimiento medido depende del navegador y del equipo; «fin habla→primer playback» es una
  estimación de planificación, no una medición acústica.
- La conversación no se persiste: recargar la página borra la historia.

La tabla identifica el proveedor y añade transcripción→primer playback estimado cuando el navegador no ofrece un fin de habla válido. Interrumpir se mantiene disponible hasta terminar la reproducción, aunque la descarga ya haya terminado.
