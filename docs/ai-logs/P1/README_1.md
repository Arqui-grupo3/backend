# AI logs — P1 — EnergyShark · Entrega 2

- Integrante: P1 (Francisco), ciudad REE, grupo 3.
- Asistente: Claude (aplicación de Claude, con acceso al enunciado público en Notion y a una copia local del backend de la E1).
- Periodo documentado: 21–23 de octubre de 2026, America/Santiago.
- Alcance: roadmap y reparto, spec, milestones, AGENTS.md, ADR de AD4–AD6, post-mortems de AD1–AD3 y corrección del heartbeat del connector.

## Índice

| Registro | Contenido |
| --- | --- |
| [01 · Planificación y decisiones](2026-10-21-23-p1-01-planificacion-y-decisiones.md) | Roadmap y priorización, spec, milestones, AGENTS.md, ADR 0004–0006, post-mortems de AD1–AD3 y su revisión cruzada. |
| [02 · Heartbeat del connector](2026-10-22-23-p1-02-heartbeat-connector.md) | Corrección del heartbeat, watchdog, `restart: always` y prueba local. |

## Criterios de edición

Se mantiene el criterio del equipo (ver [README general](../README.md)). Los prompts del usuario se citan tal como se escribieron, incluidas faltas de tipeo. Se omitieron mensajes de mera continuación y las salidas de terminal pegadas en la conversación, que se resumen en "Contexto aportado". Las respuestas de la IA se resumen; no son una transcripción literal.

No se compartieron credenciales con el asistente. Las pruebas del connector se hicieron contra un RabbitMQ local, sin usar las credenciales reales de REE.

## Estado que respaldan estos registros

Los documentos generados (spec, milestones, AGENTS.md, ADR y post-mortems) fueron revisados y corregidos por el usuario antes de subirse. El cambio del connector se aplicó a mano en el repositorio oficial y se probó en local: el contenedor quedó `healthy`.
