## DEFECTOS
- src/master.ts:352 — El `clearTimeout(timer)` del bloque `finally` cancela el plazo al llegar los headers, dejando `await response.json()` (src/master.ts:361) sin timeout: con un cuerpo que no cierra, `plan()` sigue pendiente a los 20 001 ms medidos, contra los 15 s que exige el plan y que documenta docs/MASTER.md:96. — Mover el `clearTimeout(timer)` a un `finally` que envuelva también la lectura del cuerpo (o hacer `await response.json()` dentro del mismo `try` con el controller vivo) y añadir una prueba con un `ReadableStream` que nunca cierre, verificando que rechaza con el error de timeout.

## RIESGOS
- src/master.ts:146 — `negatesMoveVerb` marca negación si CUALQUIER palabra de `NEGATION_WORDS` aparece en cualquier posición antes del verbo, no sólo pegada a él: medido, `"no me gusta el cafe, mueve la pelota roja a la hoja"` → `chat`. Falla hacia el lado seguro (nunca mueve de más), pero en un canal de voz es una orden legítima que se pierde en silencio.
- src/master.ts:135 — `isQuestion` busca `?`/`¿` en todo el texto crudo: medido, `"mueve la pelota roja a la hoja, ¿ok?"` → `chat`. Mismo sesgo seguro, misma trampa de uso.
- src/master.ts:102 — `MOVE_VERB_PATTERN` es una lista cerrada; `"empujes"`/`"muevas"` no son ni orden ni negación. Medido: `"por favor no empujes la pelota roja al papel"` → `chat` por accidente (el verbo no se reconoce), no por la regla de negación. El constructor lo declaró honestamente en sus DUDAS.
- docs/MASTER.md:133 — Límite declarado y real: una pregunta dictada por voz sin signo ni palabra interrogativa inicial («mueves la pelota roja a la hoja») se clasifica como orden. Está documentado, pero el canal previsto ES voz.
- Nunca se ejecutó una llamada real a Nebius (docs/MASTER.md:125 lo admite). La existencia de `nvidia/nemotron-3-super-120b-a12b` y el comportamiento de `chat_template_kwargs.enable_thinking` en ese endpoint siguen sin verificarse desde este pilar.
- La «verificación adversarial propia» que el constructor reporta corrió en `/tmp/organima-master-check` y dice haberla borrado: no es evidencia, es una afirmación sin artefacto. No influyó en este veredicto — re-medí todo por mi cuenta.
- G2 compila sólo `src/master.ts`, no la aplicación: el pilar puede estar verde y `src/server.ts` seguir roto. Es intencional según el contexto, pero nadie ha probado la integración.
```
