# AI logs — P2 — EnergyShark

- Integrante: P2, ciudad REE, grupo 3.
- Asistente: Codex.
- Periodo documentado: 6–7 de octubre de 2026, America/Santiago.
- Conversación: «Revisar avances del proyecto P2».
- Alcance: revisión del roadmap, protocolo, contratos, despliegue y adaptación de persistencia tratados en esta conversación.

## Índice

| Registro | Contenido |
| --- | --- |
| [01 · Alcance y configuración](2026-10-06-07-p2-01-alcance-y-configuracion.md) | Responsabilidades P2, decisiones de trabajo, ADR y configuración del broker. |
| [02 · Protocolo y validaciones](2026-10-06-07-p2-02-protocolo-y-validaciones.md) | Envelope v2, publicador común, identidad AMQP, tipos de datos y ACK/NACK. |
| [03 · Contratos JSON Schema](2026-10-06-07-p2-03-contratos-json-schema.md) | Esquemas, ejemplos, validación local y eliminación de scripts. |
| [04 · Despliegue y broker](2026-10-06-07-p2-04-despliegue-y-broker.md) | EC2/ECR, imágenes, Git, propuestas descartadas y petición real a la central. |
| [05 · Persistencia PostgreSQL](2026-10-06-07-p2-05-persistencia-postgresql.md) | Incompatibilidad packageBody/data, cambio conservador, pruebas y commit desplegado. |

## Criterios de edición

Se conservaron las preguntas, requisitos, decisiones y correcciones relevantes del usuario. Se omitieron sus mensajes de mera continuación, como «Vamos paso a paso entonces», «Okay, haz el siguiente paso», «vamos con el siguiente paso entonces» y «sigamos con los otros contenidos». El trabajo técnico asociado a esas continuaciones permanece descrito en los flujos.

Se mantienen indicaciones sustantivas aunque contengan palabras como «vamos» o «continúa»: pedir validar sender, implementar transfer o actualizar el avance del roadmap expresa una decisión técnica.

Los prompts del usuario se reproducen en los bloques de cita. Las respuestas de la IA, salidas extensas de terminal y pasos de implementación se resumen: estos archivos no son una transcripción literal completa. Los mensajes automáticos de interfaz y el razonamiento interno de la IA no forman parte de los logs.

Se conservaron las propuestas rechazadas y los errores de diagnóstico relevantes para reflejar el uso real y la revisión humana. Las contraseñas, tokens y URLs con credenciales se omiten.

## Estado que respaldan estos registros

La conversación confirmó una solicitud válida al broker y una respuesta ACK más distance-table. También confirmó la descarga y construcción del commit de adaptación Client. Al último mensaje operativo todavía faltaban la comprobación del nuevo almacenamiento en EC2 y la prueba real de NACK.

Los archivos describen esta conversación histórica, no el estado actual de todo el repositorio ni trabajos de otros integrantes o chats. Deben acompañar el resto de artefactos de proceso del equipo; no sustituyen sus ADR, contratos, spec o revisión de PR.

---

# AI logs — P2 — Entrega 2

- Integrante: P2, ciudad REE, grupo 3.
- Asistente: Claude Code (Claude Opus 5.5).
- Periodo documentado: 5–6 de noviembre de 2026, America/Santiago.
- Conversación: «Trabajo de Arquitectura de Sistemas de Software (E2)».
- Alcance: diagnóstico del comprador y de la caída del nodo, informe de span (RDOC05), endpoint y vista de RF06, revisión de las anomalías 3 y 5 de la demo y el deploy fallido del 6-11.

## Índice

| Registro | Contenido |
| --- | --- |
| [06 · Diagnóstico del comprador y caída](2026-11-05-06-p2-06-diagnostico-comprador-y-caida.md) | Cobertura 0 % por línea de crédito, hipótesis descartadas y causa de la caída del 27-10 al 05-11. |
| [07 · Informe de span y post-mortem](2026-11-05-06-p2-07-informe-span-y-postmortem.md) | RDOC05 con datos de producción, contrafactual del libro, New Relic y post-mortem del incidente. |
| [08 · Endpoint y vista RF06](2026-11-05-06-p2-08-endpoint-y-vista-rf06.md) | `GET /experiment/span`, vista del frontend y errores corregidos en el camino. |
| [09 · Anomalías y deploy fallido](2026-11-06-p2-09-anomalias-y-deploy-fallido.md) | Anomalías 3 y 5, corrección del comprador (#53) y módulos faltantes en la imagen del master. |

## Criterios de edición

Se priorizaron los pedidos de diagnóstico y corrección de errores. Se omitieron los mensajes muy generales o de continuación, como el pedido inicial de ayuda con el trabajo, el envío de los enunciados como contexto, «Soy el P2 en el roadmap», «Que mas podemos hacer mientras», «Leerlo con Chrome», «Primero pego Notion» y las confirmaciones del tipo «Sí, te la paso». El trabajo asociado a ellos queda descrito en los registros.

Las salidas de terminal pegadas por el usuario se resumen. El nombre del host de la EC2 se reemplazó por `<host-ec2>`. Se conservaron las hipótesis equivocadas y los errores de la IA, porque muestran el proceso real de diagnóstico y la revisión humana.
