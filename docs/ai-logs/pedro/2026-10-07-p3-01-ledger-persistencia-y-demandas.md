# AI log — P3 — Ledger, persistencia y demandas

- Integrante: P3, equipo EnergyShark, ciudad REE.
- Herramienta: Codex.
- Periodo: 7 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «Ledger persistente y demandas de Fase 1 y Fase 2».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> Implementar la tarea P3: modelo del ledger en PostgreSQL, aplicación de status-statement y transfer según ADR 0002. Requerimos inmutabilidad, idempotencia por idpk y que el estado sea reconstruible.

> Aplica las demandas de la central (demand-statement) con su convención de signos: quantity positivo suma energía y descuenta presupuesto; quantity negativo retira energía y abona presupuesto. Sin emitir ni esperar transfer adicional.

## Contexto aportado

El usuario definió las responsabilidades de P3 correspondientes a la Fase 1 y primera parte de Fase 2 del roadmap:
- La ciudad REE debe mantener su propio libro contable append-only en PostgreSQL 16.
- Se reutiliza la tabla `api_audit` de P4 para registrar duplicados (`DUPLICATE_IDPK`) sin alterar los saldos.
- Se implementó precisión decimal arbitraria mediante `numeric` de PostgreSQL para evitar imprecisiones de coma flotante.
- Cada ciclo obtiene su estado energético del `status-statement` más reciente; transferencias y demandas pueden recibirse antes o después del estado sin perderse.

## Trabajo asistido

1. Creación de migración `master/migrations/001-ledger.sql` con tabla inmutable `ledger_events` (trigger que bloquea `UPDATE`, `DELETE`, `TRUNCATE`) y vista de proyección `cycle_state`.
2. Implementación de control transaccional con bloqueo consultivo `pg_advisory_xact_lock(2173, 1)` para serializar el orden de aplicación contable y evitar condiciones de carrera.
3. Migración aditiva `master/migrations/002-demand.sql` agregando `demand-statement` y su convención aritmética sobre energía y fondos.
4. Implementación de tabla de control `ledger_migrations` para aplicar migraciones incrementalmente una sola vez.
5. Suite de pruebas unitarias e integradas con servidor HTTP y PostgreSQL real en `master/test/ledger.test.js`.

## Revisión y decisiones del usuario

- Se optó por la Alternativa B del ADR 0002 (event log append-only con estado proyectado) en lugar de una tabla de saldos mutable.
- Se decidió explícitamente no importar el historial antiguo de E0 automáticamente, fijando la línea base contable en cero al momento de la instalación para evitar inventar saldos no verificables.
- Se estableció que la API retorne los balances decimales como cadenas de texto (`string`) para preservar exactitud.

## Resultado y límites

- Commits asociados: `9e9fede` y `d1cd4c3`.
- Saldo de demandas y transferencias verificado contra pruebas automatizadas.
- Limitación explícita: los reportes hacia la central se mantuvieron deshabilitados por defecto (`REPORTS_ENABLED=false`) hasta completar la contabilización de negociaciones voluntarias.
