# Pilar voz — síntesis de habla (ElevenLabs)

Este documento describe `src/voice.ts` y sus pruebas. El pilar convierte en audio un texto que
**ya fue decidido** por otra capa. No hay interfaz web aquí y no se generan textos.

## Frontera con las otras capacidades

| Capacidad | Quién | Qué hace |
|---|---|---|
| Generación de texto y razonamiento | NVIDIA en Nebius (`docs/provider-contracts.md`) | Decide **qué se dice**: conversación, decisiones y política de atención. |
| Investigación web | Tavily | Aporta evidencia externa. Nunca se convierte en instrucciones ni en voz. |
| **Síntesis de habla (este pilar)** | **ElevenLabs** | Convierte texto ya aprobado en audio. **No** decide qué decir, no investiga y no es fuente de hechos. |

ElevenLabs es sólo transporte texto→audio. La voz del navegador (`SpeechSynthesis`) sigue siendo
el respaldo etiquetado del MVP, no una vía de este módulo: aquí no se implementan interfaces web.

## Contrato

```ts
import { createVoice } from './src/voice.js';

const voice = createVoice(); // producción: process.env y fetch nativo
const status = voice.status();
const audio: Uint8Array = await voice.synthesize('Hola, Santiago.', signal);
```

- `createVoice(options?: { env?: Record<string, string | undefined>; fetcher?: typeof fetch })`
  - `env`: entorno a leer. Por defecto `process.env`.
  - `fetcher`: `fetch` inyectable. Por defecto el `fetch` nativo de Node.
- `status(): { configured; provider: 'elevenlabs'; voiceId?; language: 'es'; state }`
- `synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array>`
  - Devuelve los bytes de audio en memoria. **No** escribe archivos ni persiste audio.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `ELEVENLABS_API_KEY` | Sí | Header `xi-api-key`. Nunca se registra ni se devuelve. |
| `ELEVENLABS_VOICE_ID` | Sí | Id de la voz mexicana elegida por el arquitecto. Nunca está hardcodeada; se lee del entorno. |

El id de voz debe ser **alfanumérico** (los ids de ElevenLabs lo son). Esa validación protege la
URL: un id con `/`, espacios o cualquier símbolo se rechaza como error de configuración antes de
tocar la red. Al construir la ruta se aplica además `encodeURIComponent`.

## Petición al proveedor

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream
xi-api-key: <ELEVENLABS_API_KEY>
content-type: application/json

{
  "text": "<texto recortado>",
  "model_id": "eleven_flash_v2_5",
  "language_code": "es",
  "voice_settings": { "stability": 0.45, "similarity_boost": 0.75 }
}
```

`eleven_flash_v2_5` privilegia la latencia para conversación en vivo. Faltaría una validación
auditiva real de la voz (ver *Pendiente*).

## Reglas de entrada y salida

- **Texto**: debe ser `string`, no vacío después de `trim` y de máximo **1600** caracteres. El
  texto enviado va recortado. Un texto inválido se rechaza antes de llamar al proveedor.
- **Timeout**: **15 s** (`VOICE_TIMEOUT_MS`). El reloj se combina con la señal del llamador
  usando `AbortSignal.any`, así que la cancelación llega en cuanto cualquiera de las dos dispara.
- **Respuesta**: se exige `content-type: audio/*`. Un `application/json`, un `text/*` o un
  content-type ausente se rechazan: un cuerpo JSON nunca se devuelve como si fuera MP3.
- **Tope de audio**: **5 MB** (`MAX_AUDIO_BYTES`). Se lee en streaming y, si el total lo excede,
  se cancela la descarga y se falla. Exactamente 5 MB sí se acepta.
- **Audio vacío**: no se acepta; `status()` no pasa a `ready`.
- **Sin persistencia**: el buffer de audio se devuelve a quien llama y se olvida. Este módulo no
  escribe archivos, ni siquiera temporales.

## Estados de `status()`

| `state` | Significado |
|---|---|
| `unconfigured` | Falta `ELEVENLABS_API_KEY` o `ELEVENLABS_VOICE_ID` (o están en blanco). |
| `error` | Configuración mal formada (id no alfanumérico) o último fallo del proveedor / timeout. |
| `untested` | Configuración completa, todavía sin audio válido. Estado inicial sano. |
| `ready` | Ya se recibió al menos un audio válido y no vacío. |

`ready` sólo se alcanza con audio válido. Un fallo posterior pasa a `error`, y un éxito posterior
vuelve a `ready`. Una cancelación del llamador (barge-in) **no** degrada el estado: es una
operación normal, no una falla del proveedor.

## Barge-in

El barge-in lo origina el **navegador**: cuando la persona interrumpe, el cliente corta la
reproducción y aborta la petición en curso pasando un `AbortSignal` a `synthesize`. El módulo
propaga ese aborto a `fetch` mediante la señal combinada, libera el timer y rechaza con un error
de nombre `AbortError`; no marca `error` en `status()`. Si el navegador no está disponible, el
respaldo etiquetado es su propia síntesis; este pilar no la sustituye en silencio.

## Secretos y errores

- Nunca se registra `ELEVENLABS_API_KEY` (ni en mensajes, ni en `status()`, ni en consola).
- Nunca se lee ni se publica el **cuerpo** de un error del proveedor: sólo el status HTTP, en el
  mensaje `ElevenLabs respondió HTTP <status>`.
- El `content-type` inesperado se limpia (sin controles, recortado) antes de mencionarlo.

## Pruebas

```bash
node --import tsx --test test/voice.test.ts          # 15 pruebas, sin red
npx tsc --noEmit --strict --skipLibCheck --target ES2022 \
  --module NodeNext --moduleResolution NodeNext src/voice.ts
```

Las pruebas inyectan `fetch` (`fetcher`): no hay red, ni servicios existentes, ni directorios
ajenos. Cubren petición exacta, validación alfanumérica del id, falta de configuración,
cancelación, timeout, HTTP de error, content-type no-audio, tope de 5 MB, audio vacío, éxito y
no filtración de secretos.

## Pendiente (honesto)

- No hay validación auditiva del audio real ni llamada verificada contra ElevenLabs en esta
  entrega: `docs/ARCHITECTURE.md` (2026-09-22) registra la voz mexicana como *disponible* y su
  audio como *sin validar*. Ninguna prueba de este pilar demuestra acceso real a la API.
- El tope de audio y el content-type se validan por contrato; el formato exacto del audio
  (MP3/PCM) lo decide el proveedor y no se decodifica aquí.
