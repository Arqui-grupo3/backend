# ADR 0002 — Persistencia del ledger

## Contexto

El ledger registra el estado energético y de presupuesto de la ciudad REE a
lo largo de ciclos de 2 horas. Sobre él se aplican cuatro clases de
operaciones: `status-statement` (estado inicial del ciclo), `transfer`
(fondos recibidos), `demand-statement` (la central entrega o retira energía,
con su convención de signos) y las negociaciones voluntarias con su pago.

Heredamos de la Entrega 0 un contenedor Postgres 16 corriendo en la misma
EC2.

## Alternativas consideradas

### A. Snapshot por ciclo

Una fila por ciclo con los balances finales de energía y presupuesto.

- **A favor:** el modelo más simple; las consultas de RF01 son un `SELECT`
  directo y no hay que calcular nada.
- **En contra:** cumple *reconstruible* pero no *explicable*. Perdemos el
  detalle de cómo se llegó a ese balance, y no hay forma de señalar la última
  operación aplicada, que RF01 pide explícitamente. También deja sin
  evidencia el registro de duplicados de RF05.

### B. Event log append-only con estado derivado

Cada mensaje aplicado se inserta como una fila inmutable (`idpk`, `msgId`,
`cycleId`, `type`, contenido, instante de aplicación). El estado de un ciclo
es el pliegue de sus eventos en orden.

- **A favor:** satisface las dos mitades de la propiedad de forma natural —
  el balance se recalcula y la secuencia de eventos *es* la explicación. La
  última operación de un ciclo es la última fila. Encaja directo con RF01 y
  RF05, y el `idpk` como clave única de la tabla es lo que hace idempotente la
  aplicación (ver ADR 0003).
- **En contra:** cada lectura de balance implica recorrer eventos. Con el
  volumen de esta entrega es irrelevante, pero no escala indefinidamente.
  Requiere una vista o consulta de proyección para las pantallas.

### C. Híbrido: event log más snapshot materializado por ciclo

B, y además una tabla de balances por ciclo que se actualiza al cerrar.

- **A favor:** lecturas rápidas sin perder la trazabilidad.
- **En contra:** dos representaciones del mismo estado que pueden divergir, y
  más código que escribir y probar en cinco días. Optimiza un problema de
  rendimiento que no tenemos.

## Decisión propuesta

**B**, sobre el Postgres que ya corre en la EC2.

El argumento decisivo no es técnico sino de requisitos: el enunciado pide que
el estado sea *explicable*, y RF01 pide identificar la última operación
aplicada de cada ciclo. Un snapshot no puede responder ninguna de las dos; un
log responde ambas sin trabajo extra.

Descartamos C por plazo: si las lecturas se vuelven un problema, se agrega la
proyección materializada después, sin cambiar el modelo de escritura.

Esquema mínimo:

- `ledger_events` — `id`, `idpk` (único), `msg_id`, `cycle_id`, `type`,
  `payload` JSONB, `applied_at`. Append-only, nunca se actualiza ni se borra.
- `rejected_messages` — mensajes descartados, duplicados o respondidos con
  NACK, con su razón (RF05).
- Vista `cycle_state` que pliega `ledger_events` por `cycle_id` y entrega
  balance energético, presupuesto y última operación.

## Consecuencias

- Las filas del log son inmutables. Un error de aplicación se corrige con un
  evento compensatorio, nunca editando una fila anterior.
- Las pantallas leen de la vista, no de la tabla cruda.
- La unicidad de `idpk` es la garantía de que un mensaje reenviado no se
  aplica dos veces, y es la evidencia que la demo va a revisar en la anomalía
  de duplicados.
- El `payload` en JSONB nos deja guardar el mensaje tal como llegó, lo que
  hace mucho más fácil explicar cualquier ciclo pasado durante la defensa.