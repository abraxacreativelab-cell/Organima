# Auditoría C4 — Organima

22 de septiembre de 2026. Revisión contra el sitio oficial de Simon Brown, solicitada por el usuario. Alcance principal: mapa de sistemas, contextos y contenedores. Esta auditoría distingue conformidad de representación y disponibilidad operativa; un diagrama correcto no certifica un servicio funcionando.

## Criterio y correcciones

| Hallazgo en la versión anterior | Corrección | Fundamento |
|---|---|---|
| Un único contexto mezclaba núcleo y prueba A/B como si compartieran operación. | Mapa general del proyecto y contextos separados para núcleo y laboratorio. | Un contexto se centra en un sistema; el paisaje explica una colección. |
| C1 incluía HTTPS, gRPC, WebRTC y tecnologías del robot. | Relaciones de negocio y capacidades en C1; protocolos en C2. | El contexto debe poder leerse por personas no técnicas. |
| C2 agrupaba por dispositivo/VPS e incluía Nginx, PM2 y puertos. | Frontera lógica de cada sistema; información de ejecución al runbook. | Contenedores son aplicaciones/almacenes; ubicación e infraestructura corresponden a despliegue. |
| Flechas bidireccionales y algunas relaciones sin etiqueta. | C1/C2 usan dependencias dirigidas con verbo y propósito; se indica esa semántica. | Cada relación debe tener dirección e intención inequívocas. |
| Los SVG dependían del texto exterior para entender el alcance. | Título interno y leyenda en cada vista principal; nombres, tipos y responsabilidad en cada elemento. | Cada dibujo debe ser comprensible por sí mismo. |
| GitHub parecía memoria consultada durante el runtime. | Se documenta como distribución de código/knowledge; fuera del contexto de operación. | Mostrar las dependencias pertinentes al alcance elegido. |
| Robot futuro y servicios bloqueados podían confundirse con conexiones reales. | Robot físico fuera del contexto actual; Jev marcado explícitamente como bloqueo operativo. | Estado y alcance coherentes con el código y las pruebas. |

Fuentes: [contexto de sistema](https://c4model.com/diagrams/system-context), [paisaje de sistemas](https://c4model.com/diagrams/system-landscape), [contenedores](https://c4model.com/diagrams/container).

## Orden de lectura y composición

1. **Paisaje:** reconocer los dos sistemas propios y sus dependencias.
2. **Contexto del núcleo:** operador → Organima → capacidades externas.
3. **Contexto del laboratorio:** operador de pruebas → laboratorio → proveedores.
4. **Contenedores:** ampliar exactamente la frontera del contexto correspondiente.
5. **Componentes y código:** ampliar unidades nombradas en la vista superior.
6. **Secuencia, estados y operación:** explicar comportamiento y despliegue por separado.

El orden izquierda a derecha, los colores y la separación en dos contextos son decisiones de este proyecto, no reglas impuestas por C4. C4 es independiente de herramienta y notación. Se mantiene Mermaid con títulos, etiquetas y leyendas explícitas. Azul identifica elementos propios; gris dependencias; ámbar un bloqueo escrito también en el nodo. Las diferencias no dependen sólo del color. [Notación oficial](https://c4model.com/diagrams/notation).

## Comprobaciones de las vistas principales

- Título identifica tipo y sistema de interés.
- Personas y sistemas en C1; aplicaciones y almacenes dentro de la frontera en C2.
- Tipos, nombres y responsabilidades visibles.
- Tecnología y protocolo en C2, sin detalles de infraestructura física.
- Dependencias unidireccionales, etiquetadas y sin conexión inventada entre núcleo y laboratorio.
- Leyenda explica colores, contornos, flechas y abreviaturas.
- Separación explícita de implementación y disponibilidad de la cuenta Jev.
- Renderización de los diagramas y revisión visual de contexto y contenedores.

Estos criterios se derivan de la [lista de revisión oficial](https://c4model.com/diagrams/checklist). Las vistas inferiores conservan mayor detalle técnico; la auditoría de composición se centra en los niveles superiores solicitados. La frontera elegida para el laboratorio deberá revisarse cuando exista integración operativa con el núcleo.
