# Organima — arquitectura acordada y límites de esta entrega

## Resultado observable
Una célula registra una observación, el organismo conserva sus relaciones y su historia, La política de atención decide prioridad, NVIDIA en Nebius conversa y MiniCPM en Nebius interpreta imágenes, Tavily aporta evidencia externa vinculada a esa experiencia, y una célula robot recibe un objetivo cuyo éxito exige observación independiente. Panel web muestra cada paso y diferencia simulación de ejecución real.

## Decisiones 2026-09-22
- Repo nuevo público Organima; no hereda despliegues ni datos del Garden existente.
- Constructor DeepSeek, juez Opus 5, arquitecto integra y reejecuta pruebas. Autorización expresa para trabajo nocturno.
- Jev reactivado por instrucción del usuario vía Vercel AI Gateway; primera llamada bloqueada por tarjeta requerida (403), ver JEV.md. NVIDIA/Nebius preferidos tanto visión como generación conversacional. Síntesis de voz es una capa separada; ElevenLabs si disponible, voz del navegador sólo como respaldo etiquetado.
- Tavily es la única salida de investigación web del runtime. Proveedores de inferencia y GitHub son transporte/infraestructura, no fuentes alternativas de investigación.
- Contexto por célula → grafo compartido → conocimiento estable en Git local, sincronizado a GitHub. Estado actual es proyección rápida del grafo.
- Para el MVP de un cuarto: un escritor de eventos JSONL local durable, reconstrucción del grafo al iniciar; no nueva base de datos ni dependencia del Supabase de producción. Crecimiento multi-proceso requerirá almacenamiento transaccional detrás de MemoryPort.
- Registro persistente de eventos relevantes, no video continuo ni audio crudo. Inferencias no se convierten en hechos observados.
- Jerarquía de objetivos con parentId; publicaciones de eventos por contrato. Nada de agentes enviándose prompts arbitrariamente.
- Máquinas de estados deterministas para ejecución y cancelación. La política de atención usa Jev vía Vercel en live seleccionado, NVIDIA como opción explícita y reglas en simulación y nunca anula parada física.
- Simulador para probar integración sin robot. Sus datos y resultados siempre marcan simulation, excluidos de evidencia de hardware.
- Nada cambia automáticamente protocolos/guardrails en Git. Consolidación produce una propuesta revisable.

## Células y procesos
Core local TypeScript/Express sirve API, grafo y panel. Cognición usa adaptadores HTTP con timeout, secretos sólo en servidor y errores explícitos. El navegador muestra stream de eventos. Robot real tendrá proceso Python/Jetson y MCU por USB/UART, implementado después del inventario. No se inventan pines ni alimentación.

## Contratos y rutas
src/contracts.ts define fronteras de módulos. GET /api/state devuelve {mode,graph,cells,providers,robot}; GET /api/events es SSE con evento state; POST /api/chat {message} devuelve ChatReply; POST /api/research {query}; POST /api/observe {imageDataUrl}; POST /api/demo/step {step:'reset'|'move'|'verify'} sólo en simulation; POST /api/goals {object,target}; POST /api/stop {}; GET /api/health; GET /api/voice muestra disponibilidad y POST /api/voice {text} sintetiza audio. Mutaciones requieren X-Organima-Token si ORGANIMA_OPERATOR_TOKEN está configurado; servidor público exige token. GET públicos no deben exponer datos privados: despliegue demo usa datos de demostración separados.

## Incertidumbre y autoridad
Cada relación conserva fuente, fecha y confianza. Duplicados no se reaplican, eventos antiguos no pisan relaciones recientes. Ocultamiento significa unknown. Robot declara awaiting_verification; cámara global es la que demuestra objetivo posterior a su ejecución. Contextos privados no son autoridad canónica.

## Riesgos y decisiones pendientes de hardware
Compatibilidad de cámaras; fuente de energía y soporte de la Jetson; capacidad de voz/barge-in del navegador y audio real; fecha/hora exacta de entrega sin confirmar. No se afirma cumplimiento del concurso hasta llamada NVIDIA en Nebius real, URL operativa y video de máximo 3 minutos.

## Secuencia de demostración
1. Mostrar objeto y consultar ubicación con evidencia.
2. Mover objeto y recibir aviso contextual, con deduplicación.
3. Solicitar objetivo robot; observar progreso y verificación independiente.
4. Investigar con Tavily una pregunta relacionada; mostrar fuentes y memoria recuperable.
5. Recordar un evento anterior. Panel revela qué memoria y qué proveedor contribuyeron.

## Disponibilidad verificada de proveedores
2026-09-22: Token Factory devolvió 200 en /v1/models y chat para Nemotron 3.5 Lightning y Nemotron 3 Super. Las llamadas necesitan chat_template_kwargs.enable_thinking=false para voz y decisiones JSON. Actualización posterior del usuario: Jev vuelve mediante Vercel AI Gateway, sin sustituir NVIDIA/Nebius para razonamiento.
Nemotron Nano Omni devolvió 404 en endpoint general y us-central1. Visión MVP usa openbmb/MiniCPM-V-4_5 en Nebius, probado con imagen roja y respuesta correcta. Esto conserva NVIDIA para conversación/razonamiento y Nebius para ambos; no se afirma que el modelo visual sea NVIDIA. Reemplazable por NVIDIA cuando exista endpoint operativo.
Tavily devolvió 200 con resultados de documentación oficial. ElevenLabs enumeró una voz femenina mexicana conversacional disponible; falta validación auditiva del audio generado.
Nebius MCP instalado en Codex con SAFE_MODE=true; perfil local organima, handshake y nebius_profiles probados. No requiere reiniciar la construcción; para herramientas nuevas en la sesión se necesita recargar conexión.
