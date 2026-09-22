# Proveedores — verificados el 22 de septiembre de 2026

## NVIDIA en Nebius Token Factory

[Referencia oficial](https://github.com/nebius/token-factory-cookbook/tree/main/models/nemotron).
`POST /v1/chat/completions`, Bearer `NEBIUS_API_KEY`. Conversación:
`nvidia/Nemotron-3_5-Lightning`; razonamiento: `nvidia/nemotron-3-super-120b-a12b`.
Ambos respondieron en pruebas reales. Enviar `chat_template_kwargs.enable_thinking=false`
para obtener contenido conversacional, con límites de salida y tiempo de espera.

## Visión en Nebius

El catálogo consultado no ofreció un modelo NVIDIA de visión utilizable: el candidato
Nemotron Omni respondió 404. Se usa explícitamente `openbmb/MiniCPM-V-4_5`, probado
con una imagen real enviada a Nebius. NVIDIA sigue a cargo de conversación y razonamiento;
no atribuimos la visión a NVIDIA. La calibración con la escena física queda pendiente.

## Tavily

[Referencia oficial](https://docs.tavily.com/documentation/api-reference/endpoint/search).
`POST https://api.tavily.com/search`, Bearer `TAVILY_API_KEY`, JSON `query`,
`max_results:5`, `search_depth:basic`, `include_answer:false`.
Guardar título, URL, contenido, puntuación y fecha de consulta. Es el único proveedor
de investigación web del organismo. Las fuentes son datos, nunca órdenes para actuar.
Una consulta real devolvió fuentes con éxito. La simulación no consulta la red.

## Voz

ElevenLabs convierte texto en audio; no razona ni investiga. Ana Sofia, español mexicano,
modelo `eleven_flash_v2_5`. Síntesis real comprobada; escucha y ajuste humano pendientes.
El dictado opcional usa el servicio de reconocimiento del navegador y se identifica como tal.

## Atención

Jev se reactiva por instrucción del usuario mediante `typesafe-ai/jev` en Vercel AI Gateway.
AI SDK 7 `experimental_evaluate`, tres preguntas booleanas con probabilidades, umbral 0.7.
`ORGANIMA_ATTENTION_PROVIDER=jev`, secreto `AI_GATEWAY_API_KEY`; sin fallback silencioso.
Primera llamada real: HTTP 403 por tarjeta requerida. Ver [JEV.md](JEV.md).
NVIDIA queda como selección explícita de atención; simulación usa reglas. Nunca se indica un proveedor conectado sólo por tener una clave:
los estados pasan de `untested` a `ready` después de recibir una respuesta válida.
