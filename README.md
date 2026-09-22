# Organima

**Un organismo. Muchas inteligencias. Una memoria.**

Organima conecta agentes, sensores y robots mediante contratos comunes. Una observación actualiza
un grafo compartido; la atención decide cuándo intervenir; NVIDIA en Nebius interpreta objetivos;
Tavily relaciona la experiencia local con evidencia externa. Un objetivo físico sólo se considera
cumplido después de recibir una observación independiente.

Primera entrega digital para el hackathon Nebius. **El robot físico todavía no está conectado.**
La simulación se identifica en la interfaz y no demuestra funcionamiento de motores.

## Ejecutar

Node.js 22 o superior:

```sh
npm ci
cp .env.example .env
npm run dev
```

Abre http://localhost:3210. El modo predeterminado es `simulation`, sin llamadas externas ni claves.
Si configuras `ORGANIMA_OPERATOR_TOKEN`, introdúcelo en «Acceso de operador» del panel.

Para usar proveedores reales, configura `.env` con `ORGANIMA_MODE=live`, claves de Nebius y Tavily,
y opcionalmente ElevenLabs. `.env` está excluido de Git. La cámara se activa mediante un botón;
el modo live mantiene el robot offline hasta implementar y probar su adaptador físico.

## Recorrido de demostración

1. Activa «Mostrar acciones de demostración» y pulsa «Reiniciar escena».
2. Pregunta «¿Dónde está la pelota roja?». La respuesta cita la observación en memoria.
3. Escribe «Mueve la pelota roja hacia la hoja». El robot simulado acepta el objetivo.
4. Espera `awaiting_verification` y pulsa «Verificar». La evidencia independiente cierra el objetivo.
5. Usa «Detener» para cancelar. Una parada invalida incluso una orden todavía pendiente en la nube.

En modo live, la investigación muestra fuentes de Tavily y la cámara envía capturas cuando cambia
la escena. Nunca se atribuyen fuentes o movimientos reales a la simulación.

## Proveedores y memoria

| Función | Implementación |
|---|---|
| Conversación | NVIDIA Nemotron 3.5 Lightning en Nebius Token Factory |
| Interpretación de objetivos | NVIDIA Nemotron 3 Super en Nebius |
| Visión | MiniCPM-V 4.5 en Nebius; no se presenta como modelo NVIDIA |
| Investigación web | Tavily, único proveedor de investigación externa |
| Voz | ElevenLabs, Ana Sofia, español mexicano; alternativa del navegador identificada |
| Contexto inmediato | Historial acotado por célula |
| Memoria compartida | Grafo reconstruible desde eventos JSONL persistidos |
| Conocimiento estable | Archivos versionados en `knowledge/` |

Jev quedó fuera del MVP por falta de acceso. Los detalles y las pruebas de disponibilidad están en
[contratos de proveedores](docs/provider-contracts.md). La proyección del estado actual pertenece
al grafo; no constituye una cuarta memoria. El archivo Git conserva conocimiento estable, no cada
fotograma ni una transcripción privada del laboratorio.

## Verificar

```sh
npm test
npm run build
npm run test:browser
```

La prueba de navegador usa Chrome local. En CI se puede instalar Chromium con Playwright y definir
`CI=true`. Las pruebas unitarias usan proveedores falsos y no consumen claves. Las pruebas reales
se documentan por separado; una prueba sin red no demuestra disponibilidad de una API.

## Construcción y operación

DeepSeek construyó los pilares y Claude Opus 5 los revisó en invocaciones independientes. El
arquitecto integró los módulos, corrigió incompatibilidades y repitió las pruebas.

- [Arquitectura y decisiones](docs/ARCHITECTURE.md)
- [Guía para construir el robot con Claude](docs/HARDWARE-CLAUDE-PROMPT.md)
- [Contrato del robot](docs/ROBOT-CONTRACT.md)
- [Instalación del MCP de Nebius](docs/NEBIUS-SETUP.md)
- [Despliegue, operación y reversión](docs/RUNBOOK.md)
- [Guion de pitch](docs/PITCH.md)

Pendientes del ensayo físico: inventario exacto, alimentación, firmware, sensores de borde,
calibración de cámara, conducción y verificación independiente. También falta grabar y subir el
video final de máximo tres minutos. El repositorio no contiene datos ni credenciales del resto
del laboratorio.
