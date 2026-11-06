# AI logs — Pedro González — EnergyShark

- Integrante: Pedro González (P1 en E2 / P3 y P5 en E1), ciudad REE, grupo 3.
- Asistentes: Codex y Google Antigravity (Gemini 3.8 Flash).
- Periodo documentado: Octubre – Noviembre de 2026, America/Santiago.
- Alcance: Ledger persistente, demand-statement, máquina de estados de venta con serialización transaccional por oferta (AD4 / RF03 / RF05), registro de auditoría de duplicados y rechazo NACK por IDENTITY_MISMATCH (RF05), robustez contable con auto-conciliación al cierre (AD5), y soporte de endpoints para las vistas RF01, RF02, RF04 y RF06.

## Índice

| Registro | Contenido |
| --- | --- |
| [01 · Ledger, persistencia y demandas](2026-10-07-p3-01-ledger-persistencia-y-demandas.md) | ADR AD2, migraciones 001 y 002, status-statement, transfer, demand-statement y contabilidad inmutable en PostgreSQL. |
| [02 · Negociaciones voluntarias y reportes durables](2026-10-07-p3-02-negociaciones-voluntarias-y-reportes.md) | ADR AD3, migraciones 003 y 004, flujo completo proposal -> confirmación -> pago en <=30s, reintento por idpk, errores PRICE_ABOVE_CAP / OVER_CAPACITY y suite de 28 tests. |
| [03 · Estado de la oferta y lock por offerId](2026-10-24-p1-03-estado-oferta-y-lock-bids.md) | Máquina de estados de venta, tablas `seller_offers` y `seller_bids`, serialización transaccional con `pg_advisory_xact_lock`, deduplicación RF05 y suite de 5 pruebas unitarias/integración. |
| [04 · Vendedor simple y publicador de mercado](2026-10-24-p1-04-vendedor-simple-publicador-mercado.md) | Publicación de ofertas competitivas frente a MET, emisión de `offer-updated`/`offer-withdrawn`, respuestas `bid-rejected` con `available` y suite de 8 pruebas integradas. |
| [05 · Registro de duplicados y NACK por IDENTITY_MISMATCH](2026-10-24-p1-05-registro-duplicados-y-nack-rf05.md) | Auditoría en `rejected_messages` de bids duplicados (`DUPLICATE_IDPK`), rechazo y sobre NACK 403 por `IDENTITY_MISMATCH`, e invarianza matemática del ledger (RF05). |
| [06 · Robustez de AD5 y Conciliación con la Wallet](2026-11-05-p1-06-robustez-ad5-reconciliacion-wallet.md) | Conciliación automática al cierre (`GET /balance`), absorción de `/statement`, recuperación reactiva de timeouts (Anomalía 4) e invarianza contable (AD5). |
| [07 · Vistas RF01, RF02, RF04 y RF06](2026-11-06-p1-07-vistas-rf01-rf02-rf04-rf06-api.md) | Endpoints de backend y modelos de datos para historial de ciclos (RF01), mercado en vivo con precio efectivo (RF02), panel de administración en caliente (RF04) y experimento de span (RF06). |

## Criterios de edición

Se conservaron las instrucciones, preguntas y decisiones técnicas del usuario. Se omitieron mensajes de mera confirmación o saludos. Los prompts del usuario se reproducen en bloques de cita y las acciones y salidas de herramientas se resumen para mantener legibilidad y trazabilidad.

Se registraron las alternativas de diseño descartadas, el diagnóstico de restricciones (claves foráneas en PostgreSQL, convenciones de signo en demandas y ordenamiento transaccional) y la verificación empírica contra la base de datos real.
