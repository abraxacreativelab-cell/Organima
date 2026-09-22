# Evidencia de la primera entrega digital

Fecha: 22 de septiembre de 2026. Las pruebas no equivalen a certificación ni a prueba del robot físico.

## Verificación local

`npm test`: pruebas sin red de memoria, robot, cognición, interfaz, Master, voz, visión e integración.
`npm run build`: compilación TypeScript completa.
`npm run test:browser`: Chrome ejecuta acceso de operador, escena simulada, objetivo por texto,
espera de verificación independiente y cierre. Se comprueban consola y desbordamiento horizontal
en escritorio y móvil. Capturas de revisión conservadas localmente en runtime, fuera del repo.

## Proveedores reales

Se ejecutó la aplicación en modo live, escuchando únicamente en localhost. El recorrido HTTP
comprobó conversación NVIDIA, investigación Tavily con fuentes, análisis de una imagen de prueba
en Nebius, síntesis de audio ElevenLabs y rechazo de controles de simulación en modo live.
Las credenciales y los resultados completos permanecen en archivos privados excluidos de Git.

El modelo visual no es NVIDIA: MiniCPM-V 4.5 se eligió después de recibir 404 del candidato Omni.
Una imagen sintética de color uniforme sólo comprueba el transporte y formato de visión;
no demuestra detección de objetos en el laboratorio. La voz generó audio, pero queda la escucha
humana para confirmar que suena como desea Santiago.

## Revisión independiente

DeepSeek construyó memoria, robot simulado, cognición, interfaz, Master, voz y puerta visual.
Opus 5 revisó cada pilar. Hubo rechazos que se corrigieron: voz de respaldo mal identificada,
preguntas confundidas con movimiento, estado de configuración incompleto y timeout que no
cubría el cuerpo de la respuesta. Las notas de rechazo se conservan como historial de revisión;
no significan que esos defectos sigan abiertos. El arquitecto volvió a ejecutar sus comprobaciones.

## Límites

No hay evidencia de motores, cámara física, micrófono o sensores de borde conectados. No se ha
grabado el video de entrega. La demostración pública, cuando esté publicada, usa sólo simulación;
las pruebas de inferencia real no deben confundirse con ese recorrido público.
