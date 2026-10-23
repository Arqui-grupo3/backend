# Post-mortems de AD1 a AD3 (E1 → E2)

Ciudad **REE** (Re-Estize) · Grupo 3 · IIC2173 · 2026-2

Este documento cubre la parte de RDOC01 que re-examina las decisiones de la E1. Para cada una se indica qué decidimos, qué implementamos realmente (según el código y la evidencia del repo), qué le pasa al contacto con la E2 y qué cambiaríamos.

> **Estado:** escrito el 22 de octubre, antes del corte a v3 (viernes 23, 13:00). Las secciones "Observado en la E2" se completan después del periodo de prueba abierta y del primer día de mercado de producción, con datos de New Relic y de la base.

| Decisión E1 | ADR | Veredicto para la E2 |
| --- | --- | --- |
| AD1 · Topología del consumo | `ADR-topologia_del_consumo.md` (0001) | Se mantiene la separación en dos procesos, pero el consumidor tiene que crecer a dos colas y el healthcheck nunca funcionó |
| AD2 · Persistencia del ledger | `ADR-Persistencia_del_ledger.md` (0002) | El event log sigue sirviendo, pero el ledger pierde autoridad: pasa a ser una proyección que se concilia contra la wallet |
| AD3 · Manejo de timeouts | `ADR-manejo_de_timeouts.md` (0003) | El flujo que implementaba fue retirado; su disciplina (idpk persistido, reintento con la misma llave, tabla de pendientes) se reutiliza para la wallet |

---

## AD1 · Topología del consumo del broker

### Qué decidimos en la E1

Dos procesos: `connector` consume `city.REE.q` por AMQPS y reenvía cada mensaje por HTTP a `master`, que es el único que escribe en la base. El `ack` al broker se hace solo después de que `master` confirma la escritura. Reconexión cada 5 s, `prefetch(1)`, mensajes inválidos descartados sin reencolar y un heartbeat en disco cada 15 s leído por el `HEALTHCHECK`.

### Qué pasó de verdad

- **La propiedad central se cumplió.** El orden "persistir y después `ack`" funcionó: en la anomalía de duplicados (`evidencia/20261007-2308`) el conteo del ledger quedó igual (`antes=104772 despues=104772 delta=0`).
- **La reconexión funcionó.** En `evidencia/20261007-2313/03-corte-broker.txt` el connector se reconecta solo tras el corte y retoma el consumo.
- **El healthcheck nunca funcionó.** `connector/healthcheck.js` lee un archivo de heartbeat que `connector/index.js` nunca escribe. Por eso la evidencia muestra `connector Up 38 minutes (unhealthy)` mientras consumía bien. El ADR prometía algo que el código no hacía, y no lo detectamos hasta revisar la evidencia.
- **El tope de reintentos no existe.** El ADR dice que reencolar sin límite "se parece a un loop de mensajería", pero el código hace `nack(msg, false, true)` tras 3 s sin contador. Con `master` caído, un mensaje se reencolaría indefinidamente.
- **Apareció una responsabilidad no prevista.** Para publicar desde la API terminamos agregando un servidor HTTP interno en el connector (`POST /publish`, puerto 3001). La topología real es bidireccional, no la que describe el ADR.

### Qué le pasa al contacto con la E2

- Hay **dos colas**: `city.REE` (dirigido a nosotros, incluidos bids de otras ciudades y eventos de la wallet) y `market.REE` (feed del mercado). La de mercado tiene TTL de un ciclo y largo máximo de 5 000: un consumidor lento pierde mensajes.
- El salto HTTP por mensaje y `prefetch(1)` eran aceptables con pocos mensajes por ciclo de 2 horas. Con ciclos de 20 minutos, ofertas de 12 ciudades más MET y bids con plazos de segundos, la latencia del camino connector → master → base pasa a ser parte del negocio.
- Los mensajes de `market.REE` **no se responden con ACK**, y los de otras ciudades exigen validar `user_id` contra `cityId` (`IDENTITY_MISMATCH`). El connector actual solo acepta `city.REE` y `city.broadcast` y descarta el resto como `UNEXPECTED_ROUTING_KEY`.
- El connector deja de ser solo un traductor: algunas decisiones (aceptar un bid, proponer un swap) tienen plazo de segundos.

### Qué cambiaríamos

- Mantener los dos procesos: el aislamiento de fallos sigue valiendo.
- Un consumidor por cola, con políticas distintas: `city.REE` con `ack` tras persistir; `market.REE` con prefetch mayor y sin respuesta al emisor, priorizando no perder el feed.
- Escribir de verdad el heartbeat (y probar el healthcheck en CI), y agregar un contador de reentregas con tope.
- Documentar en el ADR la API interna de publicación, que hoy es parte de la arquitectura y no aparece.

### Observado en la E2

_Completar después del corte: largo de `market.REE` en hora punta, mensajes perdidos por TTL, latencia connector → master en New Relic, reconexiones._

---

## AD2 · Persistencia del ledger

### Qué decidimos en la E1

Event log append-only (`ledger_events`) con `idpk` único, estado derivado por una vista `cycle_state`, mensajes rechazados en una tabla aparte. Descartamos snapshots porque no explican cómo se llegó a un saldo ni permiten identificar la última operación (RF01).

### Qué pasó de verdad

- **Funcionó bien y fue la mejor decisión de la E1.** La unicidad de `idpk` más un `pg_advisory_xact_lock` dieron idempotencia real: la suite prueba ocho duplicados concurrentes y la demo de duplicados dio `delta=0`.
- **La inmutabilidad se reforzó con un trigger** que rechaza `UPDATE`, `DELETE` y `TRUNCATE`, más de lo que pedía el ADR.
- **No se creó `rejected_messages`.** Se reutilizó la tabla `api_audit` que ya existía para RF05. Fue razonable, pero el ADR no se actualizó.
- **El volumen creció más de lo pensado.** El compose de producción advierte "83.000+ filas" y la evidencia muestra un conteo de 104 772. El ADR decía que recorrer eventos "con el volumen de esta entrega es irrelevante".
- **El saldo nunca fue oficial.** La base histórica partió en cero y el scheduler de reportes quedó deshabilitado por defecto (`REPORTS_ENABLED=false`, `LEDGER_BASELINE_CONFIRMED=false`) porque no podíamos garantizar que el saldo local fuera correcto. Es decir, ya en la E1 desconfiábamos de que el ledger local fuera la verdad.

### Qué le pasa al contacto con la E2

- **El ledger pierde autoridad.** El dinero y la energía viven en la wallet; el enunciado dice que el ledger local "sigue siendo útil para decidir, pero no tiene autoridad". Lo que en la E1 era la contabilidad pasa a ser una proyección que puede desviarse.
- Los eventos de la wallet pueden llegar **duplicados, desordenados** (un `swap-settled` después del `trade-recorded`) o **sin que hayamos recibido el 202** de la operación. El `idpk` único sigue cubriendo los duplicados, pero el orden ya no se puede suponer.
- `cycle_state` deriva el estado energético del `status-statement` y suma `transfer` y `demand-statement`. En la E2 `demand-statement` y el `transfer` de pago se retiran; la energía y los créditos cambian por swaps, transporte, desbalance y multas.
- Los saldos ya no se resetean como antes: los KWH se queman al cierre de cada ciclo y los CR arrastran, con ajuste a 3 financiamientos de referencia al abrir el mercado de producción.

### Qué cambiaríamos

- Conservar el event log y la idempotencia por `idpk`, que se trasladan sin cambios a los eventos de la wallet.
- Hacer que la aplicación de eventos sea conmutativa (que el resultado no dependa del orden), apareando cada evento con su operación por `data.idpk`.
- Agregar conciliación explícita al cierre de cada ciclo contra `GET /balance`, registrando el delta en vez de suponerlo cero (AD5).
- Materializar un snapshot por ciclo (la alternativa C que descartamos por plazo), porque ahora la necesitamos para comparar con la wallet y para RF01 con volúmenes mayores.
- Actualizar el ADR cuando cambie la implementación (caso `api_audit`).

### Observado en la E2

_Completar: cuántos ciclos cerraron con delta distinto de cero frente a `GET /balance`, causas, eventos fuera de orden recibidos._

---

## AD3 · Manejo de timeouts de negociación

### Qué decidimos en la E1

Tabla de operaciones pendientes con deadline y un worker que cada 5 s reintenta las vencidas **con el mismo `idpk`** y un `msgId` nuevo. Tope de 3 reintentos. El `negotiation-report` se reintenta en el `opensAt` que entrega la central.

### Qué pasó de verdad

- **La disciplina de idempotencia funcionó.** El `idpk` se genera una vez y se persiste; los reintentos lo leen de la base. La evidencia de duplicados muestra el mismo `give` (`d972d876…`) llegando cuatro veces y aplicado una sola.
- **El scheduler de reportes se implementó mejor que el ADR.** Usa un temporizador exacto hasta la fecha persistida más una reconciliación periódica, en lugar de un tick de 5 s, y guarda el `msgId` de cada intento antes de publicarlo para correlacionar respuestas.
- **Pero quedó apagado por defecto.** Como el saldo no estaba confirmado (ver AD2), el reporte automático depende de `REPORTS_ENABLED`. Un reporte que no sale significa multa de 50 000 créditos.
- **El ADR quedó desfasado del código.** Habla de un worker cada 5 s, mientras que el código final usa temporizadores y advisory locks. Lo documentamos al final del mismo archivo, sin revisar las secciones de arriba.

### Qué le pasa al contacto con la E2

- **El flujo se retira.** `negotiation-proposal`, `give`, `take` y el `transfer` de pago reciben `TYPE_RETIRED` (410). `master/negotiations` queda sin uso.
- **La disciplina se vuelve más necesaria, no menos.** Toda escritura a la wallet (`POST /swaps`, `accept`, `cancel`) lleva `Idempotency-Key`; un 502 o 504 puede ser una operación procesada sin respuesta y se reintenta con la misma llave. Es exactamente la regla de AD3, ahora con HTTP en vez de AMQP.
- **Los plazos se acortan.** De 30 s y ciclos de 2 h pasamos a swaps que expiran en máximo 60 s, bids que deben resolverse antes de `lastBidAt` (T+9:00) y una wallet "lenta a propósito". Un worker con granularidad de 5 s ya no es aceptable para todo.
- El `negotiation-report` se mantiene igual que en la E1, así que esa parte del scheduler se reutiliza tal cual.

### Qué cambiaríamos

- Generalizar `negotiation_jobs` a una tabla de operaciones contra la wallet (`wallet_ops`: `idpk`, tipo, payload, estado, último intento, evento recibido).
- Tratar el stream de eventos como la verdad: el timeout dispara una lectura (`GET /swaps/{id}`) antes que un reintento ciego.
- Respetar `Retry-After` en los 429 y los límites por minuto (120 escrituras, 300 lecturas).
- **Activar el scheduler de reportes por defecto** desde el primer ciclo de la E2: el reporte ya no depende de que nuestro saldo sea oficial, y la multa entra directo al score.
- Mantener el ADR al día cuando el diseño cambia durante la implementación.

### Observado en la E2

_Completar: reintentos a la wallet por tipo de error (502, 504, 429, sin evento), operaciones que resultaron procesadas pese al timeout, ciclos con multa por no reportar._

---

## Lecciones transversales

1. **Las decisiones que se apoyaron en la base de datos sobrevivieron.** La idempotencia por `idpk` único fue la pieza más reutilizable.
2. **Lo que solo existía en el ADR falló.** El heartbeat y el tope de reentregas estaban escritos, no implementados. En la E2 cada promesa de un ADR debe tener una prueba o una evidencia asociada.
3. **Los ADR se dejaron de mantener al cambiar la implementación** (`api_audit`, scheduler de reportes, API interna del connector). Proponemos revisar los ADR en cada PR que toque su área.
4. **Ya desconfiábamos del ledger local en la E1.** La E2 formaliza esa intuición: la autoridad es la wallet y nuestro trabajo es converger a ella.
