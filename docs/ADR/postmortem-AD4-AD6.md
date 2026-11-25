# Post-mortems de AD4 a AD6 (E2 → E3)

| Decisión | Veredicto para la E3 |
| --- | --- |
| AD4 · Serialización de la aceptación (ADR 0004) | Cumplió la medida: nunca dos swaps contra la misma cantidad. Falló en liberar a tiempo lo reservado; la saga (AD7) se queda con esa parte |
| AD5 · Consistencia ledger–wallet (ADR 0005) | La aplicación idempotente funcionó desde el principio; la conciliación por ciclo llegó tarde y sin la alerta prometida |
| AD6 · Estrategia como configuración (ADR 0006) | La atribución de cada ciclo a su versión funcionó siempre; las políticas con nombre y el experimento no se hicieron |

Evidencia: tablas de producción consultadas con [`postmortem-AD4-AD6-consultas.sql`](postmortem-AD4-AD6-consultas.sql), el [informe de span](../informe-span.md), el [post-mortem del transporte](postmortem-transporte-comprador.md), el [post-mortem de AD1–AD3](postmortem-AD1-AD3.md) (incidente del 27-10 al 05-11) y New Relic (`WalletCall`).

## AD4 · Serialización de la aceptación

**Prometía:** ante dos o más bids que suman más que nuestro `remaining`, con 40 ms de diferencia, un `bid-accepted` por lo que alcanza y `bid-rejected` con `available` para el resto. Medida: ningún `swap-rejected` por `INSUFFICIENT_ASSET` en KWH atribuible a una aceptación doble propia en todo el periodo de puntaje.

**Decidimos:** reserva persistida en Postgres dentro de un `pg_advisory_xact_lock(hashtext(offerId))`, antes de llamar a la wallet; el bid queda `reserved`, `proposed`, `settled`, `released` o `rejected`, y la llamada a `POST /swaps` sale fuera del lock con la `Idempotency-Key` ya persistida.

**Qué pasó:**
- **La medida se cumplió.** El vendedor propuso 25 swaps y liquidó 16 (127 160 kWh por 17,7 M CR) entre el 26-10 y el 27-10 (informe de span, sección 6). Swaps rechazados por `INSUFFICIENT_ASSET` en KWH en propuestas propias: **[dato: consulta A1]**. Bids rechazados por falta de cantidad (`QUANTITY_UNAVAILABLE`): **[dato: consulta A2]**.
- **No llegamos a ver el estímulo real.** En casi todos los ciclos MET fue el único comprador, así que casi nunca hubo dos bids compitiendo por el mismo `remaining`. La serialización la respaldan las pruebas de concurrencia, no la operación.
- **Lo que falló fue liberar.** Cuando la wallet rechazaba el `accept` del comprador (`swap-rejected` con operación `accept`), la reserva quedaba retenida hasta `closesAt` y esa cantidad no se volvía a ofrecer. Se corrigió en la E2 llamando a `releaseSwap` por `swapId` y republicando `offer-updated`.
- **Una ventana sin cubrir.** Si `master` se cae entre el commit de la reserva y el registro de la propuesta en `wallet_ops`, el bid queda `reserved` sin operación asociada. El reenvío del bid se detecta como duplicado y no vuelve a proponer, así que la cantidad queda retenida hasta el cierre. Nunca se vende dos veces, pero se deja de vender.

**Con la E3:** la saga ejecuta lo que pasa después de reservar. El nombre de la ejecución igual al `idpk` cubre el mismo bid llegando dos veces, pero no dos bids distintos por el mismo `remaining`: eso sigue siendo de AD4 (ADR 0007).

**Cambiaríamos:** guardar la propuesta en `wallet_ops` (o la fila del outbox que inicia la saga) en la misma transacción que la reserva, para cerrar la ventana; que toda reserva tenga un timeout explícito (en la E3, el del estado que la espera); y probar el estímulo en vivo con dos compradores simulados antes de entregar, no solo en pruebas.

## AD5 · Consistencia entre el ledger local y la wallet

**Prometía:** cada evento de la wallet se aplica una sola vez, en cualquier orden, y el nodo detecta por sí mismo cuando su saldo se desvió. Medida: al cierre de cada ciclo, el saldo del dashboard coincide con `GET /balance`, o el grupo explica el delta.

**Decidimos:** efectos en `wallet_effects` con una clave propia del movimiento (`swapId`, ciclo y tipo), sumas con signo independientes del orden, `wallet_ops` persistida antes de cada escritura, y conciliación por ciclo con `GET /balance` y `GET /statement`, guardada en `cycle_reconciliations` y con alerta en New Relic si el delta quedaba sin explicar.

**Qué pasó:**
- **La aplicación idempotente funcionó desde el inicio.** Duplicados registrados en `rejected_messages`: **[dato: consulta B1]**. Las pruebas cubren el mismo evento dos veces, el mismo movimiento por dos mensajes y cualquier orden de llegada.
- **Las escrituras con timeout también.** En todo el periodo hubo un solo error intermedio: un 503 en un `propose` el 27-10, reintentado con la misma `Idempotency-Key` y resuelto con 202 (informe de span, sección 6).
- **La conciliación llegó tarde.** Hasta el 05-11 no existía en el código: la hicimos a mano con SQL. Desde entonces corre sola al llegar el `imbalance-settlement`. Resultado por estado: **[dato: consulta B2]**; asientos absorbidos desde `/statement`: **[dato: consulta B3]**.
- **No detectó el peor problema de la E2.** Del 27-10 al 05-11 el nodo no persistió ningún evento por una migración no registrada (post-mortem de AD1–AD3). AD5 asumía que los eventos se aplicaban; si no se aplica ninguno, no hay delta que comparar ni conciliación que corra. Las multas de ese periodo se ven en `/statement`: **[dato: consulta B4]**.
- **Lo prometido que no se hizo:** la alerta de New Relic por delta sin explicar y el cierre energético (punto 8 del ADR). El código guardaba en `local_cr` el saldo anterior a absorber el `/statement`, así que la fila no cuadraba con su propio delta; se corrigió en la E3.

**Con la E3:** la saga reanuda su ejecución desde el mismo consumidor que aplica los efectos (ADR 0007), y la alerta "Ledger desviado" es una de las cinco que pide el enunciado.

**Cambiaríamos:** implementar la conciliación junto con el ADR y no después; agregar la alerta de ledger desviado (evento `Reconciliation`, ya en la E3); y una señal de vida del propio ledger, por ejemplo "ningún efecto aplicado en un ciclo completo", que habría detectado el incidente en 20 minutos y no en 9 días.

## AD6 · Estrategia como configuración

**Prometía:** cambiar el span, la política de aceptación o el precio a mitad de un ciclo aplica en el ciclo siguiente sin redeploy ni reinicio, y queda registrado qué estrategia corrió en cada ciclo. Medida: el experimento de RF06 se corre cambiando configuración, y la vista de RF06 atribuye cada ciclo al span que usó.

**Decidimos:** versiones append-only en Postgres, congeladas por ciclo al llegar el `status-statement`, políticas con nombre elegidas desde un registro en el código, validación antes de guardar y un interruptor de emergencia que aplica de inmediato.

**Qué pasó:**
- **La atribución funcionó siempre.** Cada ciclo quedó asociado a una sola versión, también los procesados tarde durante el incidente (informe de span, 4.3). En 14 de los 17 ciclos con bids, el primer bid salió entre 420 y 428 s, pegado al span configurado.
- **Los cambios sin redeploy funcionaron.** Hubo 5 versiones en producción: el `price_factor` bajó de 0,85 a 0,50 y luego a 0,60 desde la EC2, y la migración 014 llevó el span a 420 s; desde el 05-11 un cron rota el span entre 120, 300 y 480 s.
- **El experimento no se pudo correr.** El span estuvo fijo en 420 s mientras el comprador podía operar, y después el comprador quedó sin crédito: 146 ciclos con déficit, cobertura 0 %. La rotación del 05-11 cambia la configuración, pero no genera bids. La vista de RF06 atribuye bien, pero no tiene diferencias que mostrar.
- **Lo prometido que no se hizo:** las políticas con nombre (`aceptacion: "fifo"`, `span: rotacion`). La aceptación y la selección quedaron fijas en el código, y la rotación se hizo con un cron externo en vez de una política.
- **Dos configuraciones desconectadas.** Hasta la migración 014 el comprador tenía su propia configuración (`/buyer/config`), separada de la del vendedor. Después, la vista de administración del frontend quedó escribiendo en `node_strategy_config`, una tabla que el nodo no lee: la configuración real solo se podía cambiar con `PUT /config`.

**Con la E3:** la estrategia sigue decidiendo y la saga ejecuta (ADR 0007). `sagaEnabled` se agrega como una versión más, congelada por ciclo.

**Cambiaríamos:** una sola tabla de configuración desde el primer día, con una prueba que falle si una vista escribe en otra; la rotación del span como política del registro, no como cron; y empezar el experimento en los primeros ciclos del periodo de puntaje, antes de que el crédito decida por nosotros.
