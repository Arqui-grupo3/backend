# AI log — 2026-10-07 — Ledger Fase 1

- Solicitud: implementar la tarea P3 (Postgres, status-statement y transfer)
  después de aprobar un plan, en una rama específica y con explicación.
- Rama: `codex/ledger-fase1`, basada en `origin/main` df16662. Se incorporaron
  los endpoints nuevos del equipo antes de implementar; no se reemplazaron.
- Asistente: Codex. Trabajo: migración aditiva, event log inmutable,
  procesamiento transaccional e idempotente, proyección consultable, pruebas
  con PostgreSQL 16 y documentación.
- Se siguió ADR 0002 ya presente. Se reutilizó `api_audit` de P4 en vez de
  duplicar la tabla de auditoría propuesta en el ADR.
- Límites: sin importación histórica automática, sin demanda/negociación de
  Fase 2, sin cambios frontend/Auth0/Gateway, sin merge ni deploy.
- Verificación: servidor HTTP real y PostgreSQL 16 temporal local; Docker no
  estaba ejecutándose, por lo que no se verificó la construcción de la imagen.

## Continuación autorizada: demandas

Se implementó la convención de signos de demand-statement con migración
incremental y pruebas de duplicados, saldo negativo, llegada antes del estado
y aritmética decimal. Diez pruebas con Postgres real aprobadas. Sin despliegue.
