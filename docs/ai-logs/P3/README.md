# AI logs — P3 — EnergyShark

- Integrante: P3 (Pedro), ciudad REE, grupo 3.
- Asistentes: Codex y Google Antigravity (Gemini 3.8 Flash).
- Periodo documentado: 7 de octubre de 2026, America/Santiago.
- Rol en Roadmap: Ledger persistente, demand-statement, negociación voluntaria y scheduler de negotiation-report.
- Alcance: Persistencia append-only del ledger, contabilidad exacta de intercambios y demandas, timeouts de 30s con reintento por idpk, errores regulados y desbloqueo de reportes.

## Índice

| Registro | Contenido |
| --- | --- |
| [01 · Ledger, persistencia y demandas](2026-10-07-p3-01-ledger-persistencia-y-demandas.md) | ADR AD2, migraciones 001 y 002, status-statement, transfer, demand-statement y contabilidad inmutable en PostgreSQL. |
| [02 · Negociaciones voluntarias y reportes durables](2026-10-07-p3-02-negociaciones-voluntarias-y-reportes.md) | ADR AD3, migraciones 003 y 004, flujo completo proposal -> confirmación -> pago en <=30s, reintento por idpk, errores PRICE_ABOVE_CAP / OVER_CAPACITY y suite de 28 tests. |

## Criterios de edición

Se conservaron las instrucciones, preguntas y decisiones técnicas del usuario. Se omitieron mensajes de mera confirmación o saludos. Los prompts del usuario se reproducen en bloques de cita y las acciones y salidas de herramientas se resumen para mantener legibilidad y trazabilidad.

Se registraron las alternativas de diseño descartadas, el diagnóstico de restricciones (claves foráneas en PostgreSQL, convenciones de signo en demandas y ordenamiento transaccional) y la verificación empírica contra la base de datos real.

## Estado que respaldan estos registros

Los registros respaldan la implementación completa de **RF03** (6 puntos) y el gate de corrección **G03** (ciclo autónomo sin intervención manual). Al cierre de la sesión:
- El ledger es inmutable y calcula saldos de energía y presupuesto mediante la vista `cycle_state`.
- El scheduler de reportes opera de forma durable y respeta la corrección `REPORT_TOO_EARLY` en `opensAt`.
- La máquina de estados de negociación maneja timeouts de 30s, reintentos con el mismo `idpk` y liquidación contable automática.
- 28 de 28 pruebas automatizadas fueron ejecutadas y aprobadas contra PostgreSQL 16.
