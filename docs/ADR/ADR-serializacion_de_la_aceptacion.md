# ADR 0004 — Serialización de la aceptación de bids (AD4)

## Contexto

Aceptar un bid es proponer un swap en la wallet. Si aceptamos dos bids contra los mismos kWh, la wallet rechaza el segundo swap con `INSUFFICIENT_ASSET`. Esto no se resuelve solo porque la propuesta es asíncrona (202 y luego el evento), la wallet es lenta y a veces falla, y los bids llegan casi juntos. El `prefetch(1)` del connector (ADR 0001) ordena la llegada de los bids, no su aceptación.

| Parte | Valor |
| --- | --- |
| Fuente | Dos o más compradores |
| Estímulo | Bids por una cantidad combinada mayor que nuestro `remaining`, con 40 ms de diferencia |
| Ambiente | Mercado abierto, wallet con su latencia habitual |
| Artefacto | Camino de aceptación de bids y propuesta de swaps |
| Respuesta | Un `bid-accepted` y un swap por lo que alcanza; `bid-rejected` con `available` para el resto; nunca dos swaps contra la misma cantidad |
| Medida | Ningún `swap-rejected` por `INSUFFICIENT_ASSET` en `KWH` atribuible a una aceptación doble propia, en todo el periodo de puntaje |

## Alternativas consideradas

### A. Lock en memoria por oferta

Un mutex por `offerId` en `master`.

- **A favor:** simple y sin latencia extra.
- **En contra:** se pierde al reiniciar. Un `master` reiniciado con un swap pendiente no sabe que esos kWh están comprometidos y los vuelve a vender (anomalía 4 de la demo).

### B. No hacer `ack` del bid hasta que la wallet responda

Aprovechar el `prefetch(1)` del connector como serialización.

- **A favor:** la serialización es gratis.
- **En contra:** bloquea toda la cola `city.REE`, por donde llegan los eventos de la wallet que destrabarían la espera. Con una wallet lenta, un bid detiene el nodo completo.

### C. Reserva persistida en Postgres, con lock por oferta

Reservar la cantidad del bid en la base antes de llamar a la wallet, y confirmarla o liberarla según el evento que llegue.

- **A favor:** el chequeo y la reserva ocurren dentro del mismo lock, así que dos bids nunca reservan la misma cantidad. Sobrevive a reinicios. Reutiliza lo que funcionó en la E1 (`pg_advisory_xact_lock`, `idpk` único).
- **En contra:** una escritura extra antes de cada propuesta, y hay que liberar con cuidado las reservas cuyo evento nunca llega.

## Decisión

**C.** La propiedad exige que la cantidad quede comprometida antes de llamar a la wallet y en un lugar que sobreviva a un reinicio. A no sobrevive y B bloquea el nodo.

Mecanismo:

1. Cada bid se guarda en una tabla `bids` (clave única: su `idpk`) con estado `received` → `reserved` → `proposed` → `settled`, o `rejected` / `released`.
2. `disponible = sellable del ciclo − Σ bids en reserved, proposed o settled`.
3. En una transacción con `pg_advisory_xact_lock(hash(offerId))`: si el bid ya existe, se repite su respuesta (RF05); si cabe en `disponible`, pasa a `reserved` con el `idpk` del swap ya persistido; si no, pasa a `rejected` con `QUANTITY_UNAVAILABLE` y `available`.
4. Fuera del lock: `POST /swaps` con ese `idpk` como `Idempotency-Key`, `expiresAt` ≤ 60 s y antes de `closesAt`.
5. `swap-proposed` → `bid-accepted`; `swap-settled` → `settled` y `offer-updated`; `swap-rejected`, `swap-expired` o `swap-cancelled` → `released`.

El orden en que se atienden los bids es la política de aceptación, configurable según AD6. Este ADR solo garantiza que, sea cual sea el orden, nunca se compromete dos veces la misma cantidad.

## Consecuencias

- El `remaining` publicado descuenta lo reservado, así que los compradores ven menos de lo que tenemos mientras haya swaps pendientes.
- Un comprador que no acepta bloquea su cantidad hasta el `expiresAt` del swap; por eso el plazo es corto.
- El lock es por oferta: no bloquea los eventos de la wallet ni nuestro rol de comprador.
- Cada `swap-rejected` por `INSUFFICIENT_ASSET` sobre una propuesta nuestra se registra y se envía a New Relic, para verificar la medida.
