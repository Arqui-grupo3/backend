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
