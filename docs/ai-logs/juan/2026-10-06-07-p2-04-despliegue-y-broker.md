# AI log — P2 — Despliegue EC2, ECR, Git y prueba del broker

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Codex.
- Periodo: 6–7 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «Revisar avances del proyecto P2».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> Fue publicado todo en Git, la instancia actual sigue siendo la misma desde E0, guiame en los pasos para adaptarla y explicame el razonamiento

> Es completamente necesario este cambio? solicitado en el enunciado o roadmap?

> No se si me parece hacer el cambio, puedo simplemente probar el resto y hacer ese cambio a futuro? si la respuesta es si quiero que vuelvas a lo original, o mejor, si no hay que hacer un nuevo push no lo hagamos y rebootees

Extracto de la revisión aportada por el usuario:

> No lo apliques. Resuelve un problema que no tienes, y debilita algo que ya está bien hecho.

El mensaje incorporó la revisión de otro asistente utilizado por Francisco: conservar el rol EC2 de solo lectura y construir/publicar imágenes desde el equipo o CI.

> ¿Cuál es el problema? ¿Por qué no puedo simplemente ocupar lo que acabamos de descargar y hacer el compose directo de eso? Y tengo que hacer todo este show de inventarme cualquier cosa y clonar desde un repositorio, si los archivos ya están subidos

> Ya lo subi, ahora hago el pull dentro de la instancia y listo?

> No llego nada desde que te envie el mensaje, puede ser algun error?

## Contexto y evidencia aportada

- La EC2 ejecutaba db, master y connector de E0. El Compose activo era /home/ubuntu/energyshark/docker-compose.prod.yml.
- /home/ubuntu/energyshark no era un repositorio Git. Se descargó el backend en /home/ubuntu/energyshark-e1.
- Las imágenes activas apuntaban a latest. Las comprobaciones de archivos mostraron inicialmente un conector antiguo sin los módulos publisher y validation.
- El archivo de configuración del conector se respaldó y actualizó con permisos restringidos, conservando la verificación TLS.

## Trabajo asistido

1. Identificación del Compose realmente asociado a los contenedores mediante sus etiquetas Docker.
2. Separación entre código descargado, imagen construida y código activo en el contenedor.
3. Construcción local de imágenes etiquetadas para E1 y recreación selectiva, conservando la base de datos.
4. Uso de --pull never para probar imágenes locales y --no-deps para limitar los servicios afectados.
5. Diagnóstico de diferencias entre ramas y commits: tener un archivo en una rama o un tag de imagen nuevo no prueba que el código esperado esté desplegado.

## Propuestas corregidas o descartadas

### Heartbeat

Se propuso escribir un archivo de heartbeat para resolver el estado unhealthy. El usuario pidió confirmar si era una obligación del enunciado y decidió posponerlo. Se reconoció que esa solución concreta era opcional y se revirtieron los cambios locales de heartbeat. No se atribuyó al documento una exigencia de ese archivo.

### Permisos IAM

Un intento de push desde EC2 falló por falta de ecr:InitiateLayerUpload. Inicialmente se propuso ampliar el rol; el usuario compartió la revisión del asistente usado por Francisco y rechazó esa alternativa.

Se conservó la separación acordada: el equipo o CI construye/publica y EC2 descarga/ejecuta con permisos de lectura. No se aplicó la política propuesta. Las imágenes locales sirvieron para la prueba, sin convertir ese ensayo en evidencia de publicación en ECR.

### Despliegue con código antiguo

Se detectó más de una vez que el contenedor seguía usando una referencia o versión anterior. Se corrigió la selección de image en el Compose y, posteriormente, se comprobó el contenido real del archivo en el contenedor, además del tag.

## Prueba activa del broker

Ante ausencia de mensajes espontáneos se consultó el mecanismo request del enunciado. Se ejecutó el publicador común desde el contenedor con data.ask igual a distance-table, conservando TLS y userId AMQP.

El broker confirmó la publicación y el consumidor recibió un ack y una distance-table. Esto comprobó una interacción real de ida y vuelta. La aceptación HTTP de ambos eventos no bastó para demostrar que se conservara todo el envelope.

## Resultado y pendientes

- Publicación de una solicitud válida y respuesta de la central verificadas en los logs aportados.
- El despliegue de prueba utilizó imágenes construidas localmente en EC2.
- La integración de ramas y el flujo definitivo de publicación/despliegue debían coordinarse con el equipo.
- La prueba real de NACK seguía pendiente al cierre de esta conversación.
