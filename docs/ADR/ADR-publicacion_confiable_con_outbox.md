# ADR 0008 — Publicación confiable con outbox (AD8)

**Estado:** propuesto · 23 de noviembre de 2026 · responsable por asignar

## Contexto

Hoy `master` cambia su estado en Postgres y, ya fuera de la transacción, le pide al `connector` por `POST /publish` que publique el mensaje. Son dos escrituras a sistemas distintos sin transacción común, y entre una y otra se puede caer el contenedor o cortar el broker:

- **Oferta.** `publishSellerOffer` crea la oferta con `createSellerOffer` y después llama a `dispatchToConnector`; si falla, el error se registra en el log y el mensaje se pierde. Lo mismo pasa con `offer-updated` y `offer-withdrawn`: el mercado ve un `remaining` que ya no existe y nos llegan bids que hay que rechazar.
- **Reporte.** `report_jobs` y `report_attempts` ya persisten el `negotiation-report` antes de publicarlo, así que es un outbox a medias: un worker propio, con un `msgId` nuevo en cada intento y sin la regla de marcar como enviado solo tras la confirmación. Perderlo cuesta 50 000 créditos.
- **Inicio de la saga (AD7).** Registrar el bid y la reserva, y luego llamar a `StartExecution`, es la misma doble escritura, ahora contra AWS.

La E3 prescribe una tabla outbox para el `negotiation-report`, los mensajes de la oferta y el inicio de las sagas (G04).

| Parte | Valor |
| --- | --- |
| Fuente | El ayudante, o la mala suerte |
| Estímulo | Caída del contenedor del backend, o corte de la conexión al broker, entre el commit de un cambio de estado y la publicación de su mensaje |
| Ambiente | Mercado abierto o periodo de cierre |
| Artefacto | La tabla `outbox` y su relay |
| Respuesta | Al recuperarse, todo mensaje comprometido se publica tal como fue registrado, con el mismo `idpk`; ninguno se pierde y ninguno se inventa |
| Medida | Cero cambios de estado sin su mensaje; el atraso del outbox vuelve a cero en a lo más 60 s desde la recuperación; si la recuperación ocurre antes de `validUntil`, el `negotiation-report` del ciclo sale dentro de la ventana |

## Alternativas consideradas

### A. Publicar después del commit, con reintentos en memoria (lo actual, endurecido)

- **A favor:** sin tablas ni procesos nuevos.
- **En contra:** no cumple la prescripción, y si el contenedor se cae entre el commit y la publicación el reintento muere con él.

### B. Tabla `outbox` en la misma transacción, con un relay en `master` que hace polling

- **A favor:** atomicidad real con Postgres, que ya es la única base; el relay es un worker más, como los que ya tiene `master`; el `connector` ya publica con un canal de confirmación, así que su 200 significa que el broker confirmó.
- **En contra:** un poco más de latencia (el ciclo del polling) y una tabla que crece y hay que podar.

### C. Captura de cambios (Debezium o replicación lógica de Postgres)

- **A favor:** sin polling y sin código de relay.
- **En contra:** un componente más que operar en una EC2 chica (Kafka Connect o un slot de replicación), y no resuelve `StartExecution`, que no es un mensaje al broker.

### D. Relay en Lambda (EventBridge cada minuto)

- **A favor:** se cae aparte del backend.
- **En contra:** exige que la Lambda alcance Postgres, justo lo que AD7 descartó por exponer la base y pagar NAT, y un minuto de polling ya consume el presupuesto de 60 s.

## Decisión

**B.** Toda escritura que deba producir un mensaje inserta su fila en `outbox` **dentro de la misma transacción** que el cambio de estado. Un relay en `master` publica las filas pendientes.

**Pasan por el outbox:** `negotiation-report`; `offer`, `offer-updated` y `offer-withdrawn`; y el `StartExecution` de las sagas de vendedor y comprador (AD7). **No pasan:** los mensajes que publica una tarea de la saga, como `bid-accepted`, porque ahí el registro durable es la ejecución, que reintenta la tarea; y los `ack`/`nack` de aplicación que publica el `connector` al consumir, porque nacen de un mensaje que todavía no se confirmó al broker: si se cae antes, el broker lo reentrega y se vuelve a responder.

### Mecanismo

1. **Tabla.** `outbox(seq bigserial, idpk uuid unique, msg_id uuid unique, kind, routing_key, envelope jsonb, aggregate_key, deadline_at, status, attempts, next_attempt_at, last_error, created_at, published_at)`. `kind` es `amqp` o `start-execution`. `aggregate_key` agrupa los mensajes cuyo orden importa (el `offerId`, o el `cycleId` del reporte). `deadline_at` es `validUntil` para el reporte, `closesAt` para la oferta y el `closesAt` del bid para la saga.
2. **Escritura.** El envelope se arma completo al escribir la fila, con `idpk` y `msgId` generados en ese momento. Un reenvío del relay es **el mismo mensaje**: mismo `idpk` y mismo `msgId`. Esto acota la regla de `AGENTS.md` de "`msgId` nuevo en cada reintento": un reintento **de aplicación** (por ejemplo, el reporte sin respuesta de la central a los 30 s) es una fila nueva, con el mismo `idpk` y otro `msgId`; un reintento **de transporte** del relay no lo es.
3. **Relay.** Un worker de `master` toma un lote con `SELECT … WHERE status='pending' AND next_attempt_at <= now() ORDER BY seq FOR UPDATE SKIP LOCKED LIMIT 50`, así que dos instancias no publican la misma fila. El commit lo despierta con `NOTIFY outbox`, y además hace polling cada segundo por si se pierde la notificación. El reporte va primero en el orden.
4. **Confirmación.** Una fila `amqp` se marca `published` solo cuando el `connector` responde 200 a `POST /publish`, y eso ocurre después del confirm del broker. Una fila `start-execution` se marca cuando Step Functions responde, o cuando responde `ExecutionAlreadyExists`: el nombre de la ejecución es el `idpk` (AD7), así que esa respuesta significa que ya partió.
5. **Orden.** Dentro de un mismo `aggregate_key` no se publica una fila mientras haya otra anterior pendiente, para que el mercado no vea un `offer-updated` antes que su `offer`. Entre agregados distintos no se espera.
6. **Reintentos.** Backoff desde 1 s, ×2, tope 10 s, con jitter. Así el atraso vuelve a cero en pocos segundos después de la recuperación, y no a los 60. Un error permanente (validación del `connector`, 400 de AWS) deja la fila en `failed` y dispara una alerta; no se reintenta en bucle.
7. **Plazo vencido.** Una fila cuyo `deadline_at` ya pasó queda en `expired` y no se publica: un `offer-updated` después de `closesAt` o un reporte después de `validUntil` los rechazaría el protocolo de todos modos. Queda registrada y cuenta en la medición.
8. **Entrega al menos una vez.** Si el relay se cae después del confirm y antes de marcar la fila, la vuelve a publicar con el mismo `idpk`. Es seguro porque los receptores deduplican por `idpk` y la saga por nombre de ejecución.
9. **Migración.** `report_jobs` sigue decidiendo **cuándo** y **qué** reportar; en vez de publicar, escribe la fila del outbox. Las funciones de oferta reemplazan `dispatchToConnector` por la inserción, dentro de la transacción que ya cambia la oferta. Se despliega con el nodo en operación: primero el relay y la tabla, después cada productor por separado, para no perder ciclos.
10. **Poda.** Las filas `published` de más de 14 días se borran cada noche. Antes, la tabla sirve de fuente para el feed SSE del panel (RF01).

## Objetivos y medición

Se miden desde la propia tabla `outbox` y se exportan a New Relic. El valor medido se agrega aquí antes de entregar.

| Objetivo | Medida | Meta |
| --- | --- | --- |
| Cambios de estado sin su mensaje (fijado) | Ofertas, cambios de `remaining`, retiros, reportes y sagas iniciadas sin fila en `outbox` | 0 |
| Atraso tras la recuperación (fijado) | `now() - min(created_at)` de las filas `pending`, desde que vuelven el contenedor o el broker | 0 en ≤ 60 s |
| Reporte dentro de la ventana (fijado) | Reportes publicados antes de `validUntil` cuando la recuperación ocurrió antes | 100 % |
| Atraso en operación normal | p95 de `published_at - created_at` | ≤ 2 s |
| Mensajes inventados | Mensajes publicados sin fila en `outbox`, o con un `idpk` distinto al registrado | 0 |

## Consecuencias

- Cerramos los tres lugares donde hoy se pierden mensajes, y los productores ya no dependen de que el `connector` esté arriba al momento del commit.
- La edad de la fila pendiente más antigua es una señal directa de que algo anda mal entre el nodo y el broker; alimenta una de las alertas de RNF01 (umbral sugerido: 30 s). Cada fila trae `cycleId`, `idpk` y `msgId`, y el `swapId` cuando corresponde, para correlacionar logs.
- Es entrega al menos una vez, no exactamente una vez: la exactitud depende de la deduplicación por `idpk` en el receptor, que ya exige el protocolo.
- Pruebas: matar `master` entre el commit y la publicación (`docker kill` con un punto de corte), cortar el `connector` o el broker durante el cierre, reenvío sin segunda saga, fila con plazo vencido que no se publica, dos relays que no duplican una fila, y orden de `offer` y `offer-updated` del mismo `offerId`.
