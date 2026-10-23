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