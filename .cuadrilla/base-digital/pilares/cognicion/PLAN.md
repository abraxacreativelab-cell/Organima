# Cambio de alcance autorizado — cognición sin Jev
## Resultado observable
Usuario retiró Jev del MVP porque no puede obtener cuenta. Actualiza src/cognition.ts, test/cognition.test.ts y docs/COGNITION.md para que live funcione con NVIDIA/Nebius y Tavily exclusivamente. El arquitecto amplió AttentionDecision.provider a jev|nvidia|rules; no toques contratos.
## Tareas
Elimina Jev como requisito, estado de proveedor activo, variables y llamadas de red. decide(state) usa NVIDIA chat-completions con JSON explícito {notify:boolean,research:boolean,escalate:boolean,probability:number}, valida esquema estricto, devuelve provider nvidia. No asignar significado de probabilidad calibrada a esa autoestimación; documentar que sólo es heurística. simulation conserva reglas deterministas con provider rules. Conserva statuses chat/vision/tavily, unknown no implica conectado.
reply sigue usando decide, Tavily condicional y NVIDIA para respuesta. Mantén lectura local del estado para preguntas espaciales y exige evidencia temporal. Si pregunta actual requiere web, research true. No enmascares un fallo live como simulación. Pruebas verifican que cero rutas typesafe/openrouter se invocan. No reformatees ni cambies componentes fuera de scope. Modifica pruebas existentes y añade regresión sin TYPESAFE_API_KEY. Respeta todos los límites y protecciones originales.
## NO TOCAR
Otros módulos, package*, src/contracts.ts (ya actualizado por arquitecto), expediente. No commit/push/deploy.
