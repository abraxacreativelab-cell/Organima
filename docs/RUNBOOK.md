# Operación y despliegue de Organima

Fuente: repositorio público Organima. Runtime aislado /opt/organima; datos /var/lib/organima; configuración privada /etc/organima/demo.env. No se modifica Garden ni su base de datos. Código sólo desde GitHub.

## Local
`npm ci`, copiar .env.example a .env y configurar proveedores. `npm run dev`. HOST=127.0.0.1 por defecto. Datos en runtime/simulation o runtime/live separados. Hardware no se conecta automáticamente.

## Público
Instancia de demostración sin claves externas y con ORGANIMA_MODE=simulation, PORT=3210, HOST=127.0.0.1, ORGANIMA_DATA_DIR=/var/lib/organima, ORGANIMA_OPERATOR_TOKEN=demo. El acceso demo es deliberadamente público: sólo opera datos sintéticos. No usar ese token para una instalación live.

Nginx termina TLS y reenvía al puerto local. Dominio de demostración propuesto: organima.187-77-9-8.sslip.io. No anunciarlo activo hasta verificar HTTPS y flujos.

## Release
1. Pruebas y build locales; juez independiente; GitHub CI verde.
2. HEAD limpio, publicado e idéntico a origin/main.
3. `bash deploy/deploy.sh` clona versión exacta en releases/SHA, instala con npm ci, compila y reinicia sólo organima.
4. Comprueba /api/health local y pública, pruebas del escenario, consola y logs. Si falla salud local, script restaura versión previa; primer deploy se detiene.
5. Para rollback manual, usar el ecosystem de un SHA anterior confirmado y verificar salud; no borrar datos.

La demostración pública es un banco de integración simulado. Pruebas reales de NVIDIA, Tavily, visión y voz se ejecutan en instancia live privada hasta preparar acceso y validar su recorrido. El robot físico requiere inventario, firmware y pruebas manuales posteriores.

## Límites de la demostración
El journal tiene un límite duro de 50 MiB. Al alcanzarlo rechaza nuevas escrituras, conserva
lo existente y no amplía el archivo. No borra historia automáticamente. Para una nueva sesión
simulada, detener sólo Organima, archivar su directorio de datos fuera del runtime activo y
reiniciar con un directorio vacío; conservar el archivo anterior hasta verificar la nueva sesión.
Las mutaciones de demostración tienen además un presupuesto de 60 por minuto por instancia.
Conversación y parada mantienen su propia lógica; la parada no queda bloqueada por esa cuota.
