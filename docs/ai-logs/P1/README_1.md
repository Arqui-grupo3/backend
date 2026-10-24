# AI logs — P1 — EnergyShark · Entrega 2

- Integrante E2: P1 (Pedro González), ciudad REE, grupo 3.
- Asistentes: Claude (sesiones iniciales de planificación), Google Antigravity / Gemini 3.8 Flash (implementación y OpenSpec).
- Periodo documentado: 21–24 de octubre de 2026, America/Santiago.
- Alcance: roadmap y reparto, spec, milestones, AGENTS.md, ADR de AD4–AD6, post-mortems de AD1–AD3, corrección del heartbeat del connector, y máquina de estados de venta con serialización transaccional por oferta (AD4 / RF03 / RF05).

## Índice

| Registro | Contenido |
| --- | --- |
| [01 · Planificación y decisiones](2026-10-21-23-p1-01-planificacion-y-decisiones.md) | Roadmap y priorización, spec, milestones, AGENTS.md, ADR 0004–0006, post-mortems de AD1–AD3 y su revisión cruzada. |
| [02 · Heartbeat del connector](2026-10-22-23-p1-02-heartbeat-connector.md) | Corrección del heartbeat, watchdog, `restart: always` y prueba local. |
| [03 · Estado de la oferta y lock por offerId](2026-10-24-p1-03-estado-oferta-y-lock-bids.md) | Máquina de estados de venta, tablas `seller_offers` y `seller_bids`, serialización transaccional con `pg_advisory_xact_lock`, deduplicación RF05 y suite de 5 pruebas unitarias/integración. |
| [04 · Vendedor simple y publicador de mercado](2026-10-24-p1-04-vendedor-simple-publicador-mercado.md) | Publicación de ofertas competitivas frente a MET, emisión de `offer-updated`/`offer-withdrawn`, respuestas `bid-rejected` con `available` y suite de 8 pruebas integradas. |

## Criterios de edición

Se mantiene el criterio del equipo (ver [README general](../README.md)). Los prompts del usuario se citan tal como se escribieron, incluidas faltas de tipeo. Se omitieron mensajes de mera continuación y las salidas de terminal pegadas en la conversación, que se resumen en "Contexto aportado". Las respuestas de la IA se resumen; no son una transcripción literal.

No se compartieron credenciales con el asistente. Las pruebas se ejecutaron contra una base de datos PostgreSQL local (`energyshark_test`).

## Estado que respaldan estos registros

Los documentos y código respaldan la Fase 0 y Fase 1 completas del Roadmap para P1:
- El estado de la oferta y el bloqueo consultivo transaccional por `offerId` garantizan matemáticamente cero sobreventas y cero `INSUFFICIENT_ASSET`.
- Idempotencia nativa ante reintentos de bids (RF05).
- Restitución automática de saldo vendible ante expiración de swaps (Anomalía 3).
- Publicación de ofertas competitivas frente a MET con cota inferior de no pérdida.
- Notificación formal de rechazos (`bid-rejected`) con `available` y actualización reactiva de la pizarra (`offer-updated` / `offer-withdrawn`).
- 8 de 8 pruebas automatizadas aprobadas.
