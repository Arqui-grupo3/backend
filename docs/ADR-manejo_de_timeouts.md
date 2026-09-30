# ADR 0003 — Manejo de timeouts de negociación

## Contexto

El flujo de negociación voluntaria tiene dos plazos de 30 segundos: desde que
enviamos una propuesta hasta recibir su confirmación, y desde la confirmación
hasta el pago. Al vencer un plazo hay que reintentar la operación **con el
mismo `idpk`**, que es la llave de idempotencia del protocolo.

La propiedad exigida:

> Una operación reintentada nunca se aplica dos veces.


## Alternativas consideradas

### A. Temporizadores en memoria

Un `setTimeout` por operación pendiente dentro del proceso Node.

- **A favor:** trivial de implementar, sin latencia y sin estado adicional.
- **En contra:** los temporizadores viven solo en la memoria del proceso. Si
  el contenedor se reinicia, todas las operaciones pendientes quedan sin
  vencimiento y nadie las reintenta jamás. Dado que reiniciar un contenedor es
  un escenario explícito de la demo, esta opción falla justo donde va a ser
  probada.

### B. Tabla de operaciones pendientes con deadline, más un worker

Cada operación enviada se persiste con su `idpk`, su estado y el instante en
que vence. Un worker consulta cada pocos segundos las vencidas y las
reintenta.

- **A favor:** el estado sobrevive a cualquier reinicio; al levantar, el
  worker encuentra lo pendiente y sigue. Deja además un registro consultable
  de qué se reintentó y cuándo, útil para RF04 y para explicar el sistema en
  la defensa.
- **En contra:** la granularidad del reintento depende del intervalo del
  worker, así que se dispara con algunos segundos de retraso respecto del
  vencimiento exacto. Es una pieza móvil más que mantener.

## Decisión propuesta

**B**, con un intervalo de worker de 5 segundos.

La idempotencia no la garantiza el mecanismo de timeout sino la base de
datos: `idpk` es clave única en `ledger_events`, y la aplicación de una
operación ocurre en la misma transacción que su inserción. Un reintento que
llega con un `idpk` ya presente choca contra la restricción y no produce
efecto, sin importar cuántas veces se repita. Eso es lo que hace que la
propiedad se sostenga incluso si el reintento se dispara dos veces por una
carrera entre workers.

Reglas concretas:

- El `idpk` se genera **una sola vez**, al crear la operación, y se persiste.
  Los reintentos lo leen de la base; nunca se genera uno nuevo. Generar un
  `idpk` distinto en un reintento es exactamente lo que rompería la
  idempotencia.
- El `msgId`, en cambio, es nuevo y aleatorio en cada mensaje, incluidos los
  reintentos. La referencia al mensaje original viaja en `data.target`.
- El `idpk` debe diferir del `msgId`; si coinciden, el broker responde NACK
  con `IDPK_EQUALS_MSGID`.
- Tope de 3 reintentos por operación. Agotado, se marca como expirada y se
  registra. Reintentar sin límite se parece a un loop de mensajería, que el
  curso castiga con ban escalonado del broker.
- El `negotiation-report` tiene su propia regla: si la central responde
  `REPORT_TOO_EARLY`, se reintenta exactamente en el instante `data.opensAt`
  que ella misma entrega, no con el backoff genérico.

## Consecuencias

- Hay estado de negociación en la base de datos además del ledger, y el worker
  es un proceso que hay que monitorear: si muere, los vencimientos dejan de
  procesarse en silencio. El healthcheck del contenedor debe cubrirlo.
- El reintento llega con hasta 5 segundos de retraso sobre el vencimiento
  exacto. Es aceptable frente a plazos de 30 segundos.
- Si el worker corriera en más de una réplica, dos instancias podrían tomar la
  misma operación vencida. La unicidad de `idpk` lo vuelve inocuo, pero si se
  escala hay que agregar bloqueo a nivel de fila.
- Quedamos con evidencia persistida de cada reintento, que es lo que se
  muestra en la demo cuando el ayudante reenvía un mensaje duplicado.