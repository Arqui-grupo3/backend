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

## Continuación autorizada: negotiation-report

- Se añadió aclaración a ADR 0003 antes del código del scheduler.
- Tabla durable de trabajos e intentos, ventana derivada de validUntil, reloj
  hasta opensAt, IDs persistidos antes de publicar, ACK/error correlacionados,
  reintentos limitados y consulta protegida de evidencia.
- Se extendió el publicador del connector para conservar msgId y timestamp
  preparados por el backend; sigue adjuntando userId AMQP city.REE.
- 21 pruebas aprobadas: Postgres real, backend HTTP, scheduler con reloj
  controlado, publicador con canal AMQP simulado y prueba integrada con
  endpoint HTTP de publicación simulado, incluyendo reinicio entre intentos.
- No se contactó al broker real ni se desplegó. Reportes apagados por defecto.
- Pendientes de negocio: base inicial verificada y negociaciones voluntarias.

## Continuación autorizada: negociaciones voluntarias (P3 - M2)

- Asistente: Antigravity.
- Alcance: Flujo voluntario completo de negociación (`proposal` -> `confirmación` en <=30s -> `pago` en <=30s -> reintento con el mismo `idpk`).
- Migración `004-negotiations.sql`: tablas `negotiation_jobs` y `negotiation_attempts`, extensión de `ledger_events` (`give`, `take`) y actualización de la vista contable `cycle_state`.
- Motor durable `master/negotiations/index.js`:
  - Timeouts de 30s con reintento manteniendo el mismo `idpk` y generando un nuevo `msgId` aleatorio.
  - Tope de hasta 3 reintentos (4 intentos en total); expiración automática.
  - Flujo `take`: confirmación genera pago saliente (`transfer`) descontando fondos del presupuesto y sumando energía al ledger.
  - Flujo `give`: confirmación espera pago de la central hasta 30s; si vence, reintenta propuesta con el mismo `idpk` sin alterar el ledger; si llega el pago, liquida fondos y descuenta energía.
  - Manejo de respuestas de error de la central: `PRICE_ABOVE_CAP` (guarda `data.cap`) y `OVER_CAPACITY` (guarda `data.spare`).
  - Desbloqueo del snapshot de `negotiation-report` una vez que las negociaciones del ciclo quedan liquidadas.
- Endpoints actualizados en `master/index.js`: `POST /negotiations` crea trabajos persistentes y `GET /negotiations` consulta el estado durable.
- Verificación: 28 pruebas automatizadas aprobadas (21 heredadas + 7 nuevas de negociación voluntaria) con PostgreSQL real.

