# Ledger de Fase 1: guía de implementación

## Qué es y dónde vive

El ledger es la contabilidad de REE. Vive en PostgreSQL y lo escribe `master`.
El connector recibe mensajes de la central y los entrega a `POST /events`.
El frontend no calcula ni conserva estos saldos: más adelante los consultará
por la API.

Ejemplo desde una instalación sin saldo inicial:

1. `status-statement`: generación 100, consumo 120, costo 2.5. El balance
   energético es -20 kWh. No se descuenta automáticamente el costo de generación:
   el mensaje lo informa, no contiene una orden de pago.
2. `transfer`: quantity 500. El presupuesto queda en 500 créditos.
3. Otra entrega del mismo `idpk`: el presupuesto sigue en 500 y aparece una
   entrada `DUPLICATE_IDPK` en la auditoría existente.
4. Un ciclo nuevo recibe generación 80, consumo 60: tiene +20 kWh. No hereda
   los -20 kWh anteriores, pero el presupuesto acumulado sigue en 500.

## Decisión existente y alcance

Se implementa la alternativa B de ADR 0002: event log append-only con estado
reconstruido. No hay una tabla de saldos actualizada por separado.

Se aplican `status-statement`, `transfer` y `demand-statement` entrantes desde `sender: central`.
`quantity` se suma con su signo, tal como permite el contrato. Se conserva
`becauseOf` para trazabilidad; validar el pago contra confirmaciones, descontar
pagos salientes y coordinar timeouts corresponde al flujo de negociación de
Fase 2. No se asume que una transferencia entrante sea un pago saliente.

Propuestas, confirmaciones y reportes siguen conservándose
por el código de P4, pero NO se aplican al ledger en esta entrega. Por eso la
respuesta identifica explícitamente su alcance parcial.

## Archivos y recorrido de escritura

- `master/migrations/001-ledger.sql`: tabla, índices, protección de inmutabilidad
  y vista `cycle_state`.
- `master/ledger/index.js`: validación, migración, recepción transaccional y lectura.
- `master/index.js`: conecta la recepción existente y agrega la ruta de consulta.
- `master/test/ledger.test.js`: pruebas con servidor HTTP y Postgres reales.

Por cada recepción:

1. Se validan los campos contables y el envelope de los tres tipos soportados.
2. Se abre una transacción y se adquiere un bloqueo transaccional compartido
   por todos los escritores de este servicio. Así se obtiene un orden estable
   de aplicación incluso si llegan varias peticiones simultáneas.
3. Si ya existe el `idpk`, se registra la entrega duplicada en `api_audit` y se
   responde 200. UUIDs con mayúsculas y minúsculas representan la misma operación.
4. Si es nuevo, se guarda `events` (historial de P4/E0) y, para los tres tipos
   soportados, `ledger_events` (operación contable con envelope completo).
5. Se hace COMMIT antes de devolver 201. Si falla cualquiera de las escrituras,
   se hace ROLLBACK y se devuelve un error: el connector puede reintentar.
6. El connector ya publica el ACK de aplicación y confirma la entrega AMQP
   después de la respuesta exitosa del master. No fue necesario cambiarlo.

Un fallo después del COMMIT pero antes de la respuesta se resuelve reenviando:
la operación ya existe y no se cuenta dos veces. La misma transacción protege
la evidencia de auditoría de una entrega duplicada.

`ledger_events` rechaza UPDATE, DELETE y TRUNCATE mediante un trigger. La clave
UUID `idpk` también tiene restricción UNIQUE. Las futuras correcciones deberán
usar operaciones compensatorias explícitas, no editar filas previas.

## Cómo se obtiene el estado

La vista suma transferencias con `numeric` de PostgreSQL (evita que 0.1 + 0.2
termine como 0.30000000000000004). La API devuelve decimales como strings.

Cada ciclo obtiene su estado energético del `status-statement` de mayor
`timestamp`; `seq` desempata. Un estado viejo recibido tarde no reemplaza al
más reciente, y recibir otro estado no suma de nuevo la generación.
`validUntil` se conserva; no se descarta historia por estar vencida al consultarla.

Si llegan fondos antes del estado, se conservan y la consulta devuelve
`initialized: false` y energía `null`, no un cero inventado.

El presupuesto de una ciudad se arrastra entre ciclos. Como pueden solaparse,
la consulta de un ciclo devuelve el presupuesto global **observado cuando se
aplicó su última operación**, junto con `asOfSequence`. No es un presupuesto
reservado para ese ciclo ni un saldo final de cierre. Una operación nueva de
otro ciclo no modifica esa observación histórica. Una operación nueva del
mismo ciclo mueve su punto de observación. Los `cycleId` son cadenas opacas:
no se ordenan ni interpretan como números de ciclo.

El log conserva todos los puntos de observación; el saldo global a un punto
histórico se reconstruye sumando transfers con `seq <=` ese punto. El último
movimiento global se encuentra con `ORDER BY seq DESC LIMIT 1`.

## Consulta para P4 y P5

`GET /cycles/:cycleId/ledger` usa el middleware `authenticate` existente
(`AUTH_REQUIRED=true` en producción). Devuelve 404 si no hay operaciones
contables del ciclo. Los endpoints anteriores no cambian de formato.

Ejemplo simplificado:

```json
{
  "cycleId": "cycle-example",
  "initialized": true,
  "energyBalance": "-20",
  "budgetBalance": "500",
  "asOfSequence": "2",
  "scope": "status-transfers-and-demands",
  "historicalBaseline": "zero-at-ledger-installation"
}
```

No se conectó el frontend ni se cambiaron Auth0, Gateway o CORS.

## Historial existente y despliegue

La migración no borra ni modifica filas de `events` ni de `api_audit`. Se
reutiliza esta auditoría en lugar de crear `rejected_messages`, pues P4 ya
implementó su almacenamiento y endpoint para RF05.

**No hay reconstrucción automática del presupuesto previo a la instalación.**
Las filas antiguas pueden carecer de envelope, timestamp, dirección o cycleId;
además, una contabilidad completa requiere demandas y pagos salientes que
están fuera de Fase 1. Importarlas como si fueran completas inventaría un saldo.
La base es cero y se informa en cada respuesta. Los idpk históricos ya recibidos
siguen siendo duplicados: no se importan mediante reenvíos.

Antes de activar esto como contabilidad oficial en producción, el equipo debe
acordar la base inicial verificable y completar/reproducir las operaciones de
Fase 2. Una importación histórica deberá ser un procedimiento explícito,
validado y auditable. Esta rama no hace despliegue ni envía mensajes al broker.

## Verificación

La suite crea un esquema aislado en una base indicada por `TEST_DATABASE_URL`.
Ejecuta el servidor real y verifica migración de E0, estado y fondos, precisión
decimal, ocho duplicados concurrentes, transfer antes de status, ciclos
solapados, estado antiguo tardío, rollback ante fallo de escritura, rechazo de
payload inválido, historial de tipos todavía no aplicados, inmutabilidad y
reconstrucción después de reiniciar el servidor y reconectar a la base.

## Extensión: demand-statement

La migración `002-demand.sql` agrega las demandas al mismo registro inmutable.
La fórmula es energía += quantity y presupuesto -= quantity * valuePerKwh.
Si quantity es negativo, se retira energía y se abona dinero. Se permiten
saldos negativos; no se genera ni se espera otra transferencia por este
intercambio. Un estado recibido después de una demanda conserva su efecto.
Las migraciones se registran en `ledger_migrations` y se ejecutan una vez.
