# Post-mortems de AD1 a AD3 (E1 → E2)

| Decisión | Veredicto para la E2 |
| --- | --- |
| AD1 · Topología del consumo (ADR 0001) | Se mantienen los dos procesos; el consumo crece a dos colas |
| AD2 · Persistencia del ledger (ADR 0002) | Se mantiene el event log, pero el ledger pasa a ser una proyección que se concilia con la wallet |
| AD3 · Manejo de timeouts (ADR 0003) | El flujo fue retirado; su disciplina de idempotencia se reutiliza para la wallet |

## AD1 · Topología del consumo

**Decidimos:** `connector` consume y reenvía por HTTP a `master`, único escritor de la base; `ack` al broker solo después de persistir; reconexión cada 5 s; heartbeat en disco para el `HEALTHCHECK`.

**Qué pasó:**
- Funcionó lo central: el duplicado de la demo no cambió el ledger (`delta=0`) y el connector se reconectó solo tras el corte del broker.
- El healthcheck nunca funcionó: `healthcheck.js` leía un heartbeat que `index.js` nunca escribía, y la evidencia muestra `connector (unhealthy)` mientras consumía bien. Corregido en `fix/connector-heartbeat`, que además reinicia el proceso si deja de consumir.
- El tope de reintentos que prometía el ADR no existe: el connector reencola sin límite.
- Apareció una API interna de publicación en el connector (`POST /publish`) que el ADR no describe.

**Con la E2:** hay dos colas, `city.REE` (incluye bids de otras ciudades y eventos de la wallet) y `market.REE` (feed con TTL de un ciclo). Los mensajes de otras ciudades exigen validar `user_id`, y hoy el connector los descarta por routing key. Los plazos pasan de minutos a segundos.

**Cambiaríamos:** mantener los dos procesos; un consumidor por cola con su propia política; tope de reentregas; documentar la API interna en el ADR.

## AD2 · Persistencia del ledger

**Decidimos:** event log append-only con `idpk` único y estado derivado por una vista, en vez de snapshots por ciclo.

**Qué pasó:**
- Fue la decisión que mejor funcionó: `idpk` único más `pg_advisory_xact_lock` dieron idempotencia real (la suite prueba ocho duplicados concurrentes) y un trigger refuerza la inmutabilidad.
- El volumen llegó a unas 105 000 filas, más de lo previsto. No medimos que eso afecte el rendimiento.
- El saldo nunca fue oficial: la base partió en cero y el reporte automático quedó apagado (`REPORTS_ENABLED=false`) porque no confiábamos en el saldo local.

**Con la E2:** la wallet es la autoridad y el ledger solo una proyección. Los eventos llegan duplicados, desordenados o sin que hayamos visto su 202, y un mismo movimiento puede llegar por un evento y también aparecer en `/statement`.

**Cambiaríamos:** conservar el event log y el `idpk` para deduplicar mensajes, pero deduplicar los efectos sobre el saldo por una clave propia del efecto, compartida por todos los caminos que lo traen; conciliar cada ciclo con la wallet; guardar esa conciliación como snapshot del ciclo (la alternativa que descartamos en la E1). Ver ADR 0005.

## AD3 · Manejo de timeouts

**Decidimos:** tabla de operaciones pendientes y un worker que reintenta con el mismo `idpk` y un `msgId` nuevo, con tope de 3 reintentos.

**Qué pasó:**
- La disciplina funcionó: el `idpk` se persiste una vez y los reintentos lo reutilizan; un `give` recibido cuatro veces se aplicó una.
- El scheduler de reportes quedó mejor que el ADR (temporizador exacto y correlación por `msgId`), pero apagado por defecto. En la E2, cada reporte que no sale es una multa de 50 000 CR.
- El ADR quedó desfasado del código y no se actualizó.

**Con la E2:** el flujo se retira (`TYPE_RETIRED`), pero toda escritura a la wallet usa `Idempotency-Key` y un 502 o 504 puede ser una operación procesada: es la misma regla de AD3, ahora sobre HTTP y con plazos de segundos.

**Cambiaríamos:** generalizar la tabla a `wallet_ops`; ante un timeout, reintentar con la misma llave o leer el estado antes de reintentar a ciegas; respetar `Retry-After`; activar el reporte automático por defecto. Ver ADR 0004.
## Incidente de producción · nodo sin persistir del 27-10 al 05-11

Este incidente ocurrió en la E2 y toca a AD1 y AD2, así que lo dejamos aquí.

**Qué pasó:**
- El 27-10 (PR #41/#42, commit `984419e`) `recordEvent` empezó a insertar en `events` la columna `published_at`. La migración que la crea (`014-distance-publication.sql`) se agregó al repo y a los tests, pero **no a la lista de migraciones que `master` aplica al arrancar** (`ledger/index.js`, `migrate`).
- En producción la columna nunca existió. Desde el deploy, cada `INSERT INTO events` falló y, como `recordEvent` es una sola transacción (AD2), se deshizo todo: event log, ledger, efectos de la wallet, ciclo del comprador y reporte. Último dato persistido: 27-10 21:45:58 UTC (`cycle-249302`).
- Nadie lo detectó en 9 días. `connector` y `master` siguieron `healthy`: el healthcheck mide que el proceso consume y responde, no que persiste.
- El 05-11 20:44 UTC el commit `29484ed` agregó la migración a la lista y puso las pruebas antes de cada deploy. Tras el deploy (20:53 UTC) el nodo procesó lo que quedaba en la cola: los ciclos 249732 a 249947 (02-11 al 05-11), todos fuera de su ventana.

**Impacto:**
- Ciclos 249303 a 249731 (unos 6 días): perdidos. El broker no conservó sus mensajes de `city.REE` y no hay rastro de ellos en `events` ni en el ledger.
- El feed de mercado (`market.REE` → `market_feed`) sí siguió guardándose todos los días, porque se persiste en su propia transacción y no pasa por `recordEvent`. Eso confirma que el connector consumía bien y que la falla estaba solo en el camino de `POST /events`.
- Ciclos 249732 a 249947: procesados tarde, sin oferta (`Pasó lastOfferAt`), sin compra y con el reporte vencido. `report_jobs` registra 488 reportes `expired`.
- Cada ciclo sin reporte es una multa de 50 000 CR. Con unos 640 ciclos afectados, la multa es del orden de 30 M CR (cifra exacta en `/statement`, asientos `penalty`).
- El experimento de span (RF06) perdió sus días de datos.

**Por qué AD1 y AD2 no lo evitaron:**
- AD1: el `ack` después de persistir hizo lo correcto (no se perdió nada que el broker aún tuviera), pero el reencolado sin límite que ya señalamos convirtió un error permanente en un reintento eterno, sin alerta.
- AD2: la atomicidad hizo lo correcto (no quedó estado a medias), pero una sola transacción para todo hace que un error en una tabla auxiliar detenga también el event log.

**Cambiaríamos:**
- Una sola fuente para la lista de migraciones, usada por los tests y por `master` (o aplicar todo `migrations/` en orden). Así un test que pasa garantiza el mismo esquema que producción.
- Pruebas obligatorias antes del deploy (hecho en `29484ed`).
- Un healthcheck de `master` que falle si no persiste ningún evento en, por ejemplo, 25 minutos (un ciclo completo), y una alerta de New Relic sobre la tasa de respuestas 5xx de `POST /events`.
- Tope de reentregas en el connector con una cola de mensajes muertos, como ya proponía el post-mortem de AD1: un error permanente queda visible en vez de reintentarse para siempre.
