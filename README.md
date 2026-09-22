# Organima
Red modular de agentes, sensores y actuadores con tres niveles de memoria y un puente de investigación al mundo exterior mediante Tavily.

**Estado: construcción inicial. Hardware pendiente de inventario.** No se declara demo real ni cumplimiento del hackathon hasta registrar pruebas de proveedores, despliegue y robot.

## Ejecutar
Node.js 22 o superior. `npm ci`, copiar `.env.example` a `.env`, `npm run dev`. Abrir http://localhost:3210. `npm test` y `npm run check` verifican la base digital. La simulación está identificada y no necesita credenciales. El modo live requiere Jev, Tavily y modelos NVIDIA disponibles en Nebius.

## Arquitectura
Ver [arquitectura](docs/ARCHITECTURE.md), contratos en `src/contracts.ts` y criterios en `GATES.md`. Contexto por célula, grafo de eventos y conocimiento estable en `knowledge/`. World State es la proyección actual del grafo.

## Construcción
DeepSeek construye pilares aislados; Claude Opus 5 revisa; el arquitecto integra y repite pruebas. No se publican secretos, conversaciones privadas ni datos del laboratorio.
