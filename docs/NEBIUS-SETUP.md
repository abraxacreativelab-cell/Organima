# Nebius MCP — instalación local verificada

Guía seguida: https://github.com/nebius/mcp-server/blob/main/AGENT_SETUP.md

Instalados Python 3.13 mediante uv y Nebius CLI por instalador oficial. Autenticación federada en navegador completada; perfil local organima activo. MCP registrado en configuración de usuario Codex, no en el repo público; transporte stdio, uvx y SAFE_MODE=true.

Se verificaron initialize, tools/list y llamada nebius_profiles. El perfil respondió activo. Para incorporar herramientas a una sesión Codex existente, recargar/reiniciar la conexión cuando sea conveniente. No se reinició la aplicación mientras había construcción en curso.

Ejemplos de uso: consultar servicios disponibles, listar plataformas de cómputo, inspeccionar proyectos y revisar documentación de la CLI. Identificadores privados y tokens permanecen fuera de Git.

Token Factory usa su propia API key; el perfil de Cloud no la sustituye. La clave se guarda en .env privado. La configuración de MCP no contiene esa clave.
