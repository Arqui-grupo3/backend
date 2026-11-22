# ADR 0007 — Saga orquestada del swap (AD7)

**Estado:** propuesto · 20 de noviembre de 2026 · responsable P1

## Contexto

En la E2 el ciclo de vida de un swap es una coreografía repartida en `master`: `processIncomingBid` reserva y propone, el worker de `wallet_ops` reintenta, los handlers de eventos de `master/index.js` publican `bid-accepted` o liberan la reserva, y el worker del comprador concilia y libera bids sin respuesta a los 40 s. Para saber en qué va un swap hay que cruzar varias tablas y logs, y qué pasa cuando un evento no llega depende de qué timer lo note primero. La E3 prescribe llevar ese flujo a AWS Step Functions con tareas Lambda.

| Parte | Valor |
| --- | --- |
| Fuente | Una contraparte y la wallet |
| Estímulo | Un swap cuyo `swap-proposed` tarda, cuya contraparte nunca acepta, o cuyo evento de liquidación no llega |
| Ambiente | Mercado abierto, wallet con su latencia habitual |
| Artefacto | Las máquinas de estados de vendedor y comprador, y el consumidor que las reanuda |
| Respuesta | Cada swap termina en un estado terminal explícito (liquidado, rechazado o compensado); si no se liquidó, la reserva queda liberada y la oferta refleja el `remaining` real; un mensaje reenviado no crea una segunda ejecución |
| Medida | Ninguna ejecución abierta 60 s después de `closesAt`, ninguna reserva retenida al cierre, y los objetivos por ciclo de este ADR |

## Alternativas consideradas

### A. Orquestador propio en `master`, con estados en Postgres

- **A favor:** sin Lambdas ni problemas de red entre AWS y la EC2.
- **En contra:** no cumple la prescripción, y habría que reconstruir esperas durables, reintentos, timeouts e historial.

### B. Step Functions Standard con Lambdas y callbacks (`waitForTaskToken`)

- **A favor:** cada swap es una ejecución con historial, esperas, reintentos y compensaciones declarados en un solo lugar; esperar es gratis; el nombre de la ejecución da idempotencia de inicio.
- **En contra:** infraestructura y costo nuevos, y las Lambdas no alcanzan Postgres ni el connector, que viven en la EC2.

## Decisión

**B**, con máquinas Standard (las Express no admiten callbacks).

**Dentro de la saga:** proponer, aceptar, cancelar y consultar swaps; publicar `bid-accepted`; verificar el `swapToken` y el plazo; esperar eventos con timeout; decidir el estado terminal y pedir la compensación. **Fuera:** la estrategia (AD6), la reserva serializada por oferta (AD4), la oferta y el reporte (outbox, AD8) y la aplicación del ledger (AD5).

**El ledger se aplica en el consumidor**, no en la saga: los eventos ya se aplican una sola vez por su clave de efecto (AD5), y dos caminos escribiendo el mismo saldo romperían eso. El consumidor aplica el efecto y reanuda la ejecución que esperaba ese evento.

### Mecanismo

1. **Inicio.** `master` reserva, registra el bid y escribe la fila de `StartExecution` del outbox en la misma transacción (AD4 y AD8). El nombre de la ejecución es el `idpk` del mensaje que la inicia (el bid, o el `bid-accepted` para el comprador): un mensaje reenviado no crea una segunda saga. Esto no reemplaza a AD4: dos bids **distintos** por el mismo `remaining` se siguen serializando con la reserva bajo lock en `master`.
2. **Vendedor:** Reservar (registra la reserva ya hecha) → Proponer (espera `swap-proposed` o `swap-rejected`) → Avisar (`bid-accepted`) → EsperarCierre (espera `swap-settled`, `swap-expired` o `swap-cancelled`) → Liquidado. Si una espera vence, Reconciliar con `GET /swaps/{id}` y, si sigue `proposed`, Cancelar. Todo lo no liquidado termina en Compensar: liberar la reserva y publicar `offer-updated` con el `remaining` real.
3. **Comprador:** Verificar (firma y contenido del `swapToken`) → RevisarPlazo (al menos 5 s antes de `expiresAt` y `closesAt`) → Aceptar (espera `swap-settled` o `swap-rejected`) → Liquidado, o Reconciliar si vence. `SWAP_NOT_PROPOSED`, `SWAP_EXPIRED`, `INSUFFICIENT_ASSET` y `MARKET_CLOSED` terminan en Rechazado, que avisa a la estrategia que esa demanda sigue sin cubrir.
4. **Tokens.** Se guardan en DynamoDB **antes** de llamar a la wallet, bajo el `idpk` de la operación (`swap-proposed`, `swap-rejected`, `swap-settled` del comprador) o el `swapId` (`swap-settled` del vendedor, `swap-cancelled`, `swap-expired`). Si el evento llega antes que el token, el consumidor deja el resultado en ese ítem y la Lambda, al guardar su token con escritura condicional, completa la espera ella misma.
5. **Conexión con la EC2.** Las Lambdas llaman a la wallet con la API key de Secrets Manager y publican al broker con `amqplib`. Para liberar una reserva o registrar un resultado llaman a `POST /internal/sagas/{idpk}/resultado` de `master`, por nginx, con TLS y firma HMAC. Se descartó poner las Lambdas en la VPC: obliga a exponer Postgres y a pagar un NAT para llegar a la wallet.
6. **Reintentos.** 202 sigue; 200 continúa con el estado que devuelve la wallet; 429, 502, 503, 504 y timeouts se reintentan con la misma llave (4 intentos, desde 1 s, ×2, tope 8 s, con jitter; ante un 429 la Lambda espera primero el `Retry-After`); 422 `IDEMPOTENCY_MISMATCH`, 401 y 404 van a Compensar o Rechazado sin reintentar. El tope acota el gasto del límite de 120 escrituras por minuto.
7. **Plazos.** Proponer, Aceptar y Cancelar esperan 30 s; EsperarCierre, hasta `expiresAt` + 15 s. Ninguna espera pasa de `closesAt` + 30 s, y cada ejecución tiene un tope de 25 minutos.
8. **Plan B.** `sagaEnabled` en `strategy_config`, congelado por ciclo. Apagado, el nodo usa el flujo de la E2, que no se borra hasta entregar.

**Costo estimado:** unos USD 2,5 al mes. Step Functions: ~52 000 transiciones al mes (72 ciclos × 2 sagas × 12) → ~USD 1,2. Lambda y DynamoDB: dentro del free tier. Secrets Manager: ~USD 1,2. Son precios de lista, a confirmar. Las budget alerts se amplían a Step Functions y Lambda.

## Objetivos y medición

Se miden por ciclo desde la tabla `saga_runs` de `master` (una fila por ejecución, con rol, estado terminal, inicio, término y `closesAt`) y se contrastan con el historial de Step Functions. El valor medido se agrega aquí antes de entregar.

| Objetivo | Meta por ciclo |
| --- | --- |
| Ejecuciones abiertas 60 s después de `closesAt` (fijado) | 0 |
| Reservas retenidas al cierre (fijado) | 0 |
| Sagas resueltas antes de `closesAt` | ≥ 95 % |
| Tiempo de bid a `bid-accepted` (vendedor) | p95 ≤ 10 s |
| Sagas no liquidadas que compensan bien | 100 % |

## Consecuencias

- El historial de cada ejecución es la traza de un swap; los logs llevan `cycleId`, `swapId`, `idpk` y el nombre de la ejecución para llegar a él desde una alerta.
- Las transiciones de la saga alimentan el feed SSE y la alerta de saga atascada o fallando.
- `master` gana un endpoint interno fuera de API Gateway: superficie nueva que se revisa con Prowler. La EC2 y cada Lambda reciben solo los permisos que usan.
- Las máquinas se diseñan en la consola y se despliegan desde CDK con sus Lambdas, roles y la tabla de tokens.
- Pruebas: bid reenviado sin segunda ejecución, `swap-proposed` que tarda, comprador que nunca acepta, evento que llega antes que el token, 504 que sí se procesó, 422 sin reintento, y ninguna ejecución abierta 60 s después de `closesAt`.
