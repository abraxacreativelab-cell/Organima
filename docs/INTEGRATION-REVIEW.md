## APROBADO

Las seis correcciones D1–D6 están hechas y verificadas contra el árbol real. Ninguna introduce regresión en lo que ya estaba bien.

**Nota de estado:** mientras revisaba, el árbol pasó de "7 archivos modificados" a limpio: el arquitecto commiteó y empujó `62735da` («fix: reject unavailable goals honestly and close review findings»). HEAD = `origin/main` = `62735da`. El contenido que juzgo es idéntico al que empecé a leer.

### Compuertas — verde (re-medidas ahora, no de memoria)
```
npm test             → 219 tests, 219 pass, 0 fail (24 suites, 800 ms), rc=0
npm run build        → tsc, rc=0, sin salida
npm run test:browser → BROWSER_OK: authenticated simulation, text goal,
                       independent verification, mobile layout, no page errors, rc=0
```
218 → 219: la prueba nueva es la cuota del journal. El commit no añade ninguna cadena con forma de clave; el único archivo de entorno rastreado sigue siendo `.env.example`. No abrí `.env`.

### D1 — corregido · `src/app.ts:71,111`
Medido levantando el servicio:
```
LIVE  POST /api/goals → HTTP 409 | state failed | reason "hardware no conectado…"
      evento type = goal.rejected | payload keys = ["state","reason","status"]
      cronología   = state: failed · reason: hardware no conectado: el modo live no …
SIM   1er objetivo 202 · 2do objetivo 409 | eventos ["goal.accepted","goal.rejected"]
```
El `state` es ahora la primera clave, así que sobrevive el corte de 40 caracteres de `summarizePayload` y se lee en el renglón. El grafo ya no afirma que se aceptó lo que el robot rechazó.

### D2 — corregido · `src/app.ts:47`
Con `conversationBusy` realmente ocupado (un `master.plan` colgado; un 409 aquí significa que la parada no pasa):
```
"detente ya" · "para ya" · "para el robot" · "stop ya"   → 200 model=local-stop  PARA
"¡Para!" · "¡Alto!" · "Detén el robot" · "¡detente!"      → 200 model=local-stop  PARA
negadas: "no pares", "no te detengas", "no para el robot",
         "nunca pares", "no detengas el robot"            → 409, no para (correcto)
```
Las cuatro frases del encargo pasan, ninguna orden negada dispara la parada, y la parada sigue evaluándose antes del guardia de ocupado.

### D3 — corregido · `.github/workflows/ci.yml`
Añade `npx playwright install --with-deps chromium` y `npm run test:browser`. El cableado es consistente: `@playwright/test` 1.63.0 exige `chromium-1243`, que es exactamente lo que instala ese comando, y `channel:'chromium'` de `browser-check.ts:16` resuelve a ese build. Lo comprobé forzando `CI=1` en local: entra por esa rama y falla sólo porque mi caché tiene 1228/1234, no 1243 — mismatch de mi máquina, no del workflow. **No puedo ejecutar GitHub Actions desde aquí**: doy por verificado el cableado, no una corrida verde.

### D4 — corregido · `deploy/deploy.sh:7-8,36-44`
Exige `completed:success` del run de `ci.yml` para el SHA exacto, y falla cerrado en todos los caminos: sin `gh`, sin runs (`.[0]` nulo revienta jq) o con el run en curso (`conclusion` nulo), `set -e` aborta. El rollback ya verifica salud con el mismo bucle de 20 intentos y sale con 2 si no recupera. Probé el predicado inline contra payloads reales de `/api/health`:
```
{"ok":true,"release":"abc"} → 0   ·   release distinto → 1   ·   ok:false → 1
sin release → 1   ·   no-JSON → 1
GET /api/health con ORGANIMA_RELEASE=abc123 → {"ok":true,…,"release":"abc123"}
```
`ecosystem.config.cjs` sí propaga `ORGANIMA_RELEASE`, y `basename "$previous"` es el SHA. **No ejecuté el script ni toqué el VPS.**

### D5 — corregido · `public/app.js:1352-1357`
El `catch` ya no se rinde: apaga `remoteVoice`, llama `refreshVoices()` —que rotula la voz local concreta— avisa en `#voice-warn` y reintenta `speak(text)` por el camino local. La recursión termina porque `remoteVoice` ya es `false`.

### D6 — corregido · `src/memory.ts`, `src/app.ts:19-25`
```
journal con tope 900 B  → 5 eventos escritos, luego "capacity reached; no data was discarded"
                          versión en memoria = 5 · relectura tras el tope = 5 (sin pérdida)
arranque con el archivo por encima del tope → lanza "archive before restarting"
cuota de demo: 70 × POST /api/demo/step → {"200":60,"429":10}
               tras agotarla: /api/stop → 200 · /api/chat "para" → 200
```
Rechaza sin truncar ni descartar, y la parada nunca queda bloqueada por la cuota. La cuota va después de la autenticación, así que un anónimo no puede agotarla.

### Observaciones residuales (ninguna bloquea)

1. **Journal lleno desincroniza robot y memoria.** Si `robot.submit` acepta y el `append` siguiente choca con el tope, el cliente recibe 500 y el robot queda con objetivo activo que el journal no registra. Sólo en el borde de 50 MiB; Express 5 sí captura el rechazo y el `finally` libera `conversationBusy`.
2. **La cuota de 60/min es por instancia, no por cliente** (así lo dice el RUNBOOK). En la demo pública un visitante puede agotarla para todos. `/api/chat` está exento —correctamente, porque por ahí va la parada por texto—, así que el journal aún puede crecer por conversación; lo acota el tope duro.
3. **`#voice-warn` dice «se usa la voz local indicada» aun cuando el navegador no tiene síntesis**, en cuyo caso `#voice-name` dice lo contrario. Se contradicen en ese caso raro.
4. **ElevenLabs no se reintenta**: tras un fallo transitorio la sesión queda en voz local hasta recargar la página (`remoteVoice` sólo se re-sondea en el init).
5. **La parada por texto sigue sin cubrir** «detenlo», «frena», «párate», «para todo», «alto, para el robot». Fuera del alcance pedido, y el botón ■ los cubre.

### Lo que NO comprobé
No corrí GitHub Actions, no ejecuté `deploy/deploy.sh`, no toqué el VPS ni HTTPS/nginx/dominio, y no hice una sola llamada real a Nebius, Tavily ni ElevenLabs. Hardware offline por diseño. **No tengo evidencia de producción**, y `GATES.md` lo dice igual: G6 sigue en `EVIDENCE: pending` (2 gates sin cumplir de 7, G7 es esta revisión).

Sin defectos bloqueantes. D1 y D2, que eran los dos que sí mentían, ahora dicen la verdad.
