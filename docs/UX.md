# Experiencia de la interfaz (UX)

Panel local de Organima servido por el núcleo TypeScript/Express. Vive en `public/` —`index.html`,
`styles.css`, `app.js`— y no carga ningún framework, ninguna tipografía remota ni ningún CDN:
todo el estilo es CSS propio y todo el comportamiento es JavaScript nativo del navegador.

## 1. Qué ve la persona al abrir

- **Encabezado pegajoso**: nombre del organismo, la etiqueta de modo más visible del panel
  (`LIVE` en lima, `SIMULACIÓN` en ámbar, `ESTADO DESCONOCIDO` en gris punteado mientras no llega
  el primer estado), el estado de la conexión con el núcleo local y el botón **Detener**.
- **Escena espacial** (centro): SVG construido en código, nunca incrustado en el HTML. Dibuja las
  células en un anillo exterior, los objetos del grafo en el anillo interior y una línea por
  relación con su predicado y su confianza (`opacidad = confianza`, línea continua cuando la
  confianza es alta y punteada cuando no). En modo `SIMULACIÓN` el lienzo lleva la marca de agua
  «ESCENARIO SIMULADO». Sin datos, la escena muestra un estado vacío que dice exactamente eso.
- **Conversación** (derecha): historial con burbujas distinguibles —operador, Organima y fallo—,
  cada respuesta con su etiqueta de modo, su modelo y el desglose de la decisión de atención de
  Jev (`avisar`, `investigar`, `escalar`, `p`).
- **Organismo** (izquierda): las tres memorias, las células registradas y la salud de proveedores.
- **Instrumentos** (franja inferior): investigación externa, observación por foto, objetivo del
  robot y controles de voz y micrófono.
- **Cronología** (al pie): eventos persistidos, del más reciente al más antiguo, cada uno con su
  hora, su tipo, un resumen del payload y la célula que lo produjo.

## 2. Honestidad antes que estética

| Señal | Qué comunica |
|---|---|
| `LIVE` (lima) | El núcleo declara ejecución real. |
| `SIMULACIÓN` (ámbar) | Datos simulados; nunca evidencia de hardware ni de API real. |
| `ESTADO DESCONOCIDO` | Todavía no hay estado fiable; el panel no adivina. |
| «Sin probar» | El proveedor **nunca se ha conectado**. No es «listo». |
| «Sin configurar» | Falta la credencial en el servidor. |
| «Simulación» en proveedor | La respuesta provino del simulador, no del servicio. |

El conocimiento estable vive versionado en `knowledge/`; la API de estado todavía no lo expone, así
que la tercera memoria del panel lo declara en lugar de inventar cifras. Lo mismo aplica a las
fuentes externas: se etiquetan siempre como **evidencia de Tavily**, nunca como instrucciones.

## 3. Tres memorias

1. **Contexto por célula** — cuántas células tienen historia propia y cuántos eventos las alimentan.
2. **Grafo compartido** — versión, número de relaciones y número de eventos, con el desglose de
   cuántos eventos están marcados como simulación.
3. **Conocimiento estable** — lo que está versionado en `knowledge/`. El panel informa su estado
   real: no expuesto por la API en esta entrega.

## 4. Evidencia, no autoridad

Toda respuesta del chat y toda investigación muestran **sources** con título, enlace, extracto y
confianza. Los enlaces externos sólo se crean si la URL es `http` o `https`; en caso contrario se
muestra el texto y se avisa que el enlace no se dibuja. Cada enlace externo abre con
`target="_blank"` y `rel="noopener noreferrer"`.

Todo texto que viene de fuera —mensajes, títulos, extractos, payloads, nombres de modelo— se
escribe con `textContent`. El panel no interpreta HTML ajeno en ningún punto.

## 5. Estados vacíos y errores accionables

Cada panel tiene su estado vacío propio: «Sin células registradas todavía», «Aún no hay eventos
persistidos», «Todavía no hay conversación», «Sin relaciones todavía: el grafo está vacío y el
panel no dibuja lo que no sabe». Los vacíos que pueden llenarse con la demostración lo dicen sin
prometer nada real: invitan a abrir «Mostrar acciones de demostración» y pulsar «Reiniciar escena»,
que siempre corre etiquetado como escenario simulado. Los elementos vacíos se ocultan en cuanto hay
contenido real.

Los errores siguen tres reglas:

1. Son visibles junto al control que falló (chat, investigación, observación, objetivo, demo).
2. Se anuncian en las regiones vivas (`aria-live="polite"` y `role="alert"`) para lectores de
   pantalla.
3. **Nunca se inventa una respuesta cuando la llamada falla.** El chat escribe
   «No pude completar la respuesta: … No inventé ninguna contestación.»

Los mensajes pasan por un redactor que elimina `Bearer`, claves tipo `sk-`/`tvly-` y JWT antes de
mostrarse. El navegador no maneja ni muestra claves de API en ningún caso.

## 6. Token de operador

El campo es `type="password"`, opcional, y se conserva **sólo** en `sessionStorage` bajo la clave
`organima.operator.token`: se borra al cerrar la pestaña. Las mutaciones (`chat`, `research`,
`observe`, `goals`, `stop`, `demo/step`) viajan con la cabecera `X-Organima-Token` sólo cuando hay
token. Nunca se usa `localStorage` y el navegador no muestra ni guarda claves de API.

Esa jerga vive aquí y no en el recorrido del producto: la interfaz sólo muestra la frase
«Acceso para controlar esta demostración. Se conserva sólo en esta pestaña.», para que quien opera
sepa qué hace el campo sin leer detalles de almacenamiento ni de cabeceras.

## 7. Acciones de demostración

Los pasos `reset`, `move` y `verify` viven dentro de un bloque etiquetado «Escenario simulado»,
oculto por defecto. Sólo se habilitan cuando el estado declara `simulation`; en `LIVE`, en
`ESTADO DESCONOCIDO` o sin estado quedan deshabilitados y el panel explica por qué.

## 8. Voz y micrófono

La lectura en voz alta es **opcional y la activa la persona**: nunca suena sola. Al activarla, el
panel elige la mejor voz disponible (es-MX femenina primero), muestra el **nombre real** de la voz
elegida y advierte cuando no hay voz es-MX o no hay voces en español. El botón **Silencio** siempre
está a la vista y llama a `speechSynthesis.cancel()` para interrumpir de inmediato.

Cuando no hay ninguna voz en español, el panel **no habla**: desmarca y deshabilita el interruptor,
apaga la lectura y lo explica en el rótulo y en el aviso. Nunca cae a la voz por defecto del
navegador ni lo disimula. La decisión vive en `speakWithVoice`, función pura exportada por `app.js`
que recibe la voz, el estado del interruptor y el sintetizador: sin voz no crea la locución ni llama
a `speak`, y una prueba de `test/ui.test.ts` ejecuta ese camino en lugar de confiar en el texto.

El dictado usa `SpeechRecognition`/`webkitSpeechRecognition` cuando el navegador lo ofrece, y el
panel lo rotula como «Servicio de reconocimiento del navegador». Si no existe, lo dice y el campo
de texto sigue funcionando igual: el dictado es una comodidad, no un requisito.

**NVIDIA genera texto; la síntesis de voz es una capa separada.** El panel lo declara en la propia
interfaz para que nadie confunda una voz del navegador con una voz del proveedor de inferencia.

## 9. Foto para observar

Selector de archivo con `accept="image/*"`, límite duro de **2 MB** (los SVG se rechazan por
poder traer scripts) y vista previa local con `FileReader`. No se abre la cámara automáticamente ni
se pide permiso de captura: la persona elige el archivo.

## 10. Conexión: SSE con respaldo controlado

`GET /api/events` alimenta la interfaz por *Server-Sent Events* (`event: state`) con el mismo
objeto que `GET /api/state`. Si el flujo se cae, el panel:

- mantiene un **único** `EventSource`, cerrando el anterior antes de abrir otro;
- inicia un **único** temporizador de sondeo cada 5 s (nunca se multiplican los timers: si ya hay
  uno, no se crea otro) y los datos siguen actualizándose;
- reintenta la conexión con retroceso exponencial acotado (1 s, 2 s, 4 s… hasta 30 s).

Cuando el flujo vuelve, el sondeo se detiene. El botón **Actualizar** fuerza una lectura inmediata.
El estado de la conexión se muestra siempre en el encabezado: `Flujo SSE activo`, `Sondeo de
respaldo cada 5 s` o `Sin conexión con el núcleo local`.

## 11. Responsive y accesibilidad

- Rejilla fluida con `minmax(0, 1fr)` y `overflow-x: hidden`: **ninguna anchura provoca scroll
  horizontal**, ni en un móvil de 320 px.
- Puntos de quiebre: 1180 px (la escena pasa arriba), 900 px (una sola columna y encabezado no
  pegajoso) y 560 px (botones y compositor a ancho completo, tipografía algo menor).
- Foco visible con `outline` lima, enlace «Saltar al contenido», regiones `aria-live`, etiquetas
  `<label>` reales (varias ocultas con `.sr` cuando el contexto visual ya las explica) y
  `prefers-reduced-motion` respetado.
- Contraste reforzado cuando el sistema pide `prefers-contrast: more`.
- La paleta es de laboratorio nocturno: carbón (`#0b0e10`), acento lima (`#b6f36a`) y ámbar
  (`#ffb454`), tipografía del sistema y monoespaciada para las cifras.

## 12. Pruebas

`test/ui.test.ts` corre con `node --import tsx --test test/ui.test.ts` y no toca la red ni el DOM:
comprueba la estructura del HTML, la ausencia de CDN y de superficies de inyección
(`innerHTML`, `eval`, `document.write`), que el recorrido visible no menciona `sessionStorage` ni
`X-Organima-Token` —esa jerga vive en este documento—, que el token sólo se guarda en
`sessionStorage` dentro del código, y el contrato de las funciones puras exportadas por
`public/app.js` (modo, salud de proveedores, validación de enlaces, redacción de secretos,
normalización de estado hostil, límite de 2 MB, retroceso de reconexión y el camino de voz:
**sin voz no se llama a `speak`**, probado ejecutando `speakWithVoice` con un sintetizador falso).
