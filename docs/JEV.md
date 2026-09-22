# Jev — atención mediante Vercel AI Gateway

El usuario reactivó Jev el 22 de septiembre de 2026. Su identificador es `typesafe-ai/jev` (el nombre verbal “Jeff” se refiere aquí a Jev).

## Papel dentro del organismo

Jev evalúa el estado resumido, con mensajes y evidencia temporal procedentes de la memoria. Devuelve probabilidades para tres preguntas: avisar al operador (`notify`), investigar con Tavily (`research`) y escalar el razonamiento (`escalate`). No produce el texto conversacional ni controla motores.

- `notify`: permite el anuncio proactivo cuando `/api/observe` detecta cambios; sigue sujeto a las condiciones del servidor.
- `research`: activa Tavily en el flujo conversacional. Una solicitud explícita de búsqueda del operador conserva prioridad determinista; `researchOverride` registra esa excepción sin falsear la probabilidad que devolvió Jev.
- `escalate`: en `reply`, usa el modelo `NEBIUS_REASONING_MODEL` en lugar de `NEBIUS_CHAT_MODEL`. Si no se configura uno distinto, ambas rutas pueden usar el mismo modelo. El maestro de objetivos conserva su propia planificación NVIDIA.

Umbral inicial de las tres decisiones: **0.7**, pendiente de calibración con escenarios reales. `probabilities` conserva cada resultado; `threshold` permite auditar el corte. `probability` conserva el máximo sólo para compatibilidad con clientes anteriores, no representa una confianza conjunta. Ningún resultado sustituye evidencia visual ni prioridad de parada.

Los eventos `attention.decision` y `conversation.reply` conservan las decisiones dentro del journal del núcleo. Jev no escribe en el grafo ni en `knowledge/`; el laboratorio de voz sigue sin memoria persistente compartida. ElevenLabs Agents completo continúa fuera de este flujo: su cerebro es el agente configurado en ElevenLabs.

## Configuración

```dotenv
ORGANIMA_ATTENTION_PROVIDER=jev
AI_GATEWAY_API_KEY=
```

La clave se guarda en `.env` ignorado o en el entorno privado del proceso; nunca se envía al navegador. La alternativa explícita `ORGANIMA_ATTENTION_PROVIDER=nvidia` conserva el filtro anterior de NVIDIA. Para compatibilidad, ausencia de selector también usa NVIDIA. Una caída de Jev **no cambia de proveedor automáticamente**. En simulación no se llama a Jev ni a otros servicios.

AI SDK 7.0.111 y `@ai-sdk/gateway` están fijados en package.json/lockfile. El adaptador usa `experimental_evaluate`, `createGateway` con credencial explícita y `gateway.evaluation('typesafe-ai/jev')`. El SDK valida su protocolo y Organima valida las respuestas booleanas y el rango 0..1. Timeout de 15 segundos, sin reintentos automáticos; errores saneados, estado independiente visible en `/api/state`.

Referencias: [guía oficial AI SDK](https://vercel.com/docs/ai-gateway/sdks-and-apis/ai-sdk), [evaluación con Jev](https://vercel.com/docs/ai-gateway/getting-started/evaluation).

## Evidencia operativa

Primera prueba real mediante AI SDK: **HTTP 403**, `GatewayInternalServerError`, con mensaje de Vercel indicando que exige una tarjeta válida registrada para servir solicitudes y habilitar créditos gratuitos. Esto prueba el intercambio con el gateway, **no una evaluación exitosa del modelo**. La cuenta requiere acción de su titular; después se debe repetir la prueba. No se etiqueta `ready` sólo por tener una clave.

La revisión independiente Opus requiere volver a iniciar sesión en Claude Code en esta Mac. Hasta resolver los bloqueos y validar, no se afirma Jev funcionando en producción.

## Comprobaciones

```bash
node --import tsx --test test/attention.test.ts test/jev-integration.test.ts
npm test
npm run build
```

La prueba real explícita (`node --import tsx scripts/jev-live-check.ts`) se ejecuta con `RUN_LIVE_JEV_CHECK=1` y `DOTENV_CONFIG_PATH` apuntando al archivo privado de configuración. No usa conversaciones del operador: sólo estados sintéticos y memoria temporal descartable.
