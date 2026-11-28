# Monitoreo — pasos para replicar

EnergyShark · ciudad REE · cubre RDOC03 (pasos de monitoreo), RNF05 y G08.

En la E2 el monitoreo cubre cinco cosas: el host, la aplicación (`master`), el
consumidor de las colas (`connector`), las llamadas a la wallet y el feed de
mercado. Todo llega a una sola cuenta de New Relic, y el dashboard
`EnergyShark - mercado y wallet` (paso 8) junta lo de las colas y la wallet.

| Qué se mide | Cómo | Dónde se ve en New Relic |
| --- | --- | --- |
| Host y contenedores de la EC2 | Agente de infraestructura | **Infrastructure → Hosts** |
| `master`: peticiones HTTP, latencia, errores y SQL | Agente APM de Node | **APM & Services → energyshark-master** |
| `connector`: cada mensaje consumido de `city.REE.q` y `market.REE` | Agente APM de Node: una transacción de background por mensaje, más el evento `QueueMessage` | **APM & Services → energyshark-connector** → Transactions (tipo *Non-web*) |
| Largo de cada cola y consumidores conectados | `checkQueue` cada 30 s desde el connector: evento `QueueDepth` | Dashboard, página *Colas y feed de mercado* |
| Conexión con el broker: conexión, corte y reconexión | Evento `BrokerConnection` | Dashboard |
| Mensajes publicados (acks, nacks, ofertas, bids, reportes) | Evento `QueuePublish` | Dashboard |
| Llamadas a la wallet: latencia, estado y motivo | APM (servicio externo y transacciones `Wallet/<operación>`) + evento `WalletCall` + métricas `Custom/Wallet/...` | **External services → wallet.iic2173.org**, dashboard página *Wallet* |

## Llaves

New Relic usa dos:

| Llave | Forma | Uso |
| --- | --- | --- |
| License key | termina en `NRAL` | el agente envía datos |
| User key | empieza con `NRAK-` | el instalador habla con la API |

Ambas en **Administration → API keys**. La User key hay que crearla:
**Create a key → Key type: User**. Ninguna de las dos va al repositorio: viven en
el `.env` del servidor.

## 1. Infraestructura (en la EC2)

```bash
curl -Ls https://download.newrelic.com/install/newrelic-cli/scripts/install.sh | bash

sudo NEW_RELIC_API_KEY=NRAK-xxxx \
     NEW_RELIC_ACCOUNT_ID=<ACCOUNT_ID> \
     /usr/local/bin/newrelic install
```

Acepta la integración de Docker cuando la ofrezca: sin ella los contenedores no
aparecen como entidades separadas.

```bash
sudo systemctl status newrelic-infra    # debe decir active (running)
```

El host aparece en **Infrastructure → Hosts** a los dos minutos.

## 2. APM (dentro de `master`)

`newrelic` ya está en `master/package.json`. La primera línea de
`master/index.js`, antes de cualquier otro `require`, es:

```js
require('newrelic');
```

El orden importa: el agente instrumenta `express`, `pg` y `fetch` parchándolos al
cargarse. Si ya fueron importados, las trazas salen vacías.

En el servicio `master` de `docker-compose.prod.yml`:

```yaml
    environment:
      NEW_RELIC_LICENSE_KEY: ${NEW_RELIC_LICENSE_KEY}
      NEW_RELIC_APP_NAME: energyshark-master
      NEW_RELIC_LOG: stdout
```

Y en el `.env` de `~/energyshark` en la EC2:

```bash
NEW_RELIC_LICENSE_KEY=<license key que termina en NRAL>
```

Push a `main` para desplegar (el workflow corre las pruebas, construye las
imágenes en ECR y recrea los contenedores), y verifica:

```bash
cd ~/energyshark
docker compose -f docker-compose.prod.yml logs master | grep -i newrelic
docker compose -f docker-compose.prod.yml exec master sh -c 'curl -s localhost:3000/health'
```

En los logs tiene que aparecer `Connected to collector.newrelic.com`. Los avisos
sobre `@newrelic/native-metrics`, `gcp` y `azure` son normales: el agente prueba
proveedores de nube que no usamos.

La aplicación aparece en **APM & Services** como `energyshark-master` a los dos
minutos.

## 3. APM del connector (consumidor de las colas)

`newrelic` está en `connector/package.json`, y `connector/telemetry.js` lo carga
antes que `amqplib` (el agente instrumenta las librerías al cargarse). Sin
`NEW_RELIC_LICENSE_KEY` el agente no se carga, así que en local y en las pruebas
no hace nada.

En el servicio `connector` de `docker-compose.prod.yml`:

```yaml
    environment:
      NEW_RELIC_LICENSE_KEY: ${NEW_RELIC_LICENSE_KEY}
      NEW_RELIC_APP_NAME: energyshark-connector
      NEW_RELIC_LOG: stdout
```

Usa la misma `NEW_RELIC_LICENSE_KEY` del `.env` de `~/energyshark` que ya usa
`master`. Tras el deploy:

```bash
docker compose -f docker-compose.prod.yml logs connector | grep -i newrelic
```

La aplicación aparece en **APM & Services** como `energyshark-connector`.

Qué registra:

| Dato | Contenido |
| --- | --- |
| Transacción por mensaje | `OtherTransaction/RabbitMQ/Consume/<cola>` (o la que crea el agente para `amqplib`). Incluye la llamada a `master` (`POST /events` o `/market`) y, con distributed tracing, se enlaza con la transacción de `master` |
| `QueueMessage` | `queue`, `type`, `cityId`, `cycleId`, `outcome` (`ack`, `nack`, `discard`, `requeue`, `rejected`, `error`), `reason`, `durationMs` (proceso), `lagMs` (desde el `timestamp` del mensaje), `redelivered`, `bytes` |
| `QueueDepth` | `queue`, `messages` (en espera), `consumers`. Cada 30 s (`QUEUE_DEPTH_INTERVAL_MS`), con `checkQueue` pasivo en un canal aparte: si el broker lo rechaza, no afecta el consumo |
| `BrokerConnection` | `state`: `connected`, `closed`, `error`, `connect-failed` |
| `QueuePublish` | `exchange`, `routingKey`, `type`, `outcome`, `durationMs` |
| Métricas | `Custom/Queue/<cola>/Messages`, `.../Outcome/<resultado>`, `.../ProcessingMs`, `.../LagMs`, `.../Depth`, `.../Consumers`; `Custom/Broker/<estado>`; `Custom/Publish/<exchange>/...` |

```sql
-- Mensajes del feed por minuto y su resultado
SELECT count(*) FROM QueueMessage WHERE queue = 'market.REE' FACET outcome TIMESERIES 1 minute

-- ¿Se está atrasando el consumidor? (mensajes en espera en cada cola)
SELECT latest(messages) FROM QueueDepth FACET queue TIMESERIES AUTO

-- Tiempo de proceso y retraso del feed
SELECT percentile(durationMs, 50, 95), percentile(lagMs, 95) FROM QueueMessage
WHERE queue = 'market.REE' TIMESERIES AUTO

-- Cortes y reconexiones con el broker
SELECT timestamp, state, detail FROM BrokerConnection SINCE 1 day ago LIMIT 50
```

## 4. Llamadas a la wallet

El agente APM registra cada llamada HTTP a `wallet.iic2173.org` como servicio
externo. Cada llamada corre dentro de una transacción `Wallet/<operación>`: dentro
de una request queda como segmento, y desde los workers (comprador, reintentos,
conciliación) crea una transacción de background. Sin eso, las llamadas hechas
fuera de una request no aparecían en External services.

Además, el cliente de la wallet (`master/wallet/index.js`) registra cada llamada
como un evento propio, `WalletCall`, y como métricas `Custom/Wallet/<operación>/Calls`,
`Custom/Wallet/<operación>/DurationMs` y `Custom/Wallet/All/<Ok|Timeout|RateLimited|ServerError|ClientError>`.
Atributos de `WalletCall`:

| Atributo | Contenido |
| --- | --- |
| `operation` | `propose`, `accept`, `cancel`, `balance`, `statement`, `swap`, `leaderboard` |
| `method`, `path` | Método HTTP y ruta, sin query string |
| `status` | Código HTTP. **`0` si no hubo respuesta** (timeout o falla de red) |
| `reason` | El `reason` del cuerpo de la respuesta o el error de red (`TIMEOUT`, …) |
| `durationMs` | Duración de la llamada |
| `idpk` | La `Idempotency-Key` de la operación, para seguir un reintento |

**Vista rápida:** APM & Services → `energyshark-master` → **External services** →
`wallet.iic2173.org`. Muestra tiempo de respuesta, throughput y errores del host.

**Consultas NRQL** (Query your data → NRQL; las fechas en hora de Chile):

```sql
-- p50 y p95 de latencia por operación
SELECT percentile(durationMs, 50, 95), count(*) FROM WalletCall
SINCE '2026-10-26 00:00:00 -0300' UNTIL '2026-10-28 00:00:00 -0300'
FACET operation

-- Picos de latencia
SELECT percentile(durationMs, 95) FROM WalletCall SINCE 1 day ago TIMESERIES 30 minutes

-- Errores: 5xx, 429 (rate limit), 401 (key inválida) y 0 (sin respuesta)
SELECT count(*) FROM WalletCall
WHERE status >= 500 OR status = 429 OR status = 401 OR status = 0
SINCE 1 day ago FACET status, reason TIMESERIES 1 hour

-- Seguir una operación y sus reintentos con la misma Idempotency-Key
SELECT timestamp, operation, status, reason, durationMs FROM WalletCall
WHERE idpk = '<idpk>' SINCE 7 days ago
```

## 5. Feed de mercado, del lado de `master`

El connector consume `market.REE` (paso 3) y entrega cada oferta, `offer-updated`,
`offer-withdrawn` y `market-closed` a `master` por `POST /market`. Cada entrega es
también una transacción del APM de `master`:

```sql
-- Mensajes del feed procesados por minuto
SELECT count(*) FROM Transaction
WHERE appName = 'energyshark-master' AND request.uri = '/market'
SINCE 3 hours ago TIMESERIES 1 minute

-- Rechazos de master al feed (4xx/5xx)
SELECT count(*) FROM Transaction
WHERE appName = 'energyshark-master' AND request.uri = '/market' AND http.statusCode >= 400
SINCE 1 day ago FACET http.statusCode
```

Lo que el connector descarta antes de entregarlo queda como `QueueMessage` con
`outcome = 'discard'` y su `reason`, en su log como `Mensaje de mercado descartado`
y en la auditoría de la base (RF05).

## 6. Mensajes de la central (`city.REE`)

Del mismo modo, cada mensaje de `city.REE` llega a `master` como una transacción
`POST /events`:

```sql
SELECT count(*) FROM Transaction
WHERE appName = 'energyshark-master' AND request.uri = '/events'
SINCE 3 hours ago TIMESERIES 5 minutes
```

En cada ciclo de 20 minutos hay varios mensajes (`status-statement`, `transfer`,
`distance-table`, eventos de la wallet, `imbalance-settlement`), así que un hueco
de más de un ciclo significa que el connector o el broker dejaron de entregar.

## 7. Alertas

En **Alerts → Alert conditions → New alert condition → Write your own query**,
dentro de la política `EnergyShark - operación`:

| Condición | Consulta | Umbral |
| --- | --- | --- |
| Connector sin entregar mensajes | `SELECT count(*) FROM Transaction WHERE appName = 'energyshark-master' AND request.uri = '/events'` | Ventana de 5 min, **rellenar huecos con 0**, crítica si es **menor que 1 durante 25 min**; pérdida de señal a los 25 min |
| Errores de la wallet | `SELECT count(*) FROM WalletCall WHERE status >= 500 OR status = 429 OR status = 0` | Ventana de 5 min, crítica si es **mayor que 3 al menos una vez en 5 min** |
| Feed de mercado acumulándose | `SELECT latest(messages) FROM QueueDepth WHERE queue = 'market.REE'` | Ventana de 5 min, crítica si es **mayor que 500 durante 10 min** |
| Consumidor desconectado | `SELECT min(consumers) FROM QueueDepth` | Ventana de 5 min, crítica si es **menor que 1 durante 5 min**; pérdida de señal a los 10 min |

Sin el relleno con 0, la primera condición nunca se dispara: si el connector se
cae no llegan datos, y "menor que 1" no se evalúa sobre una serie vacía.

Para recibir los avisos por correo: **Alerts → Workflows → Add a workflow**, filtro
*Policy = EnergyShark - operación*, destino *Email*. Sin workflow los incidentes
igual quedan en **Alerts → Issues & activity**. Para probarlo sin botar el nodo,
usa **Test workflow**.

## 8. Dashboard

`docs/newrelic-dashboard.json` define el dashboard `EnergyShark - mercado y wallet`,
con dos páginas: *Colas y feed de mercado* (mensajes por cola, largo de cada cola,
consumidores, resultado y tipos del feed, tiempos de proceso y retraso,
transacciones del connector, descartes y NACK, conexión con el broker,
publicaciones) y *Wallet* (latencia p50 y p95 por operación, códigos de respuesta,
tasa de error, External services y últimas llamadas con error).

Para importarlo:

1. Reemplaza `0` por el ID de la cuenta (aparece en **Administration → Access
   management → Accounts**, o en la URL de New Relic) en cada `"accountIds": [0]`:

   ```bash
   sed 's/"accountIds": \[0\]/"accountIds": [<ACCOUNT_ID>]/' docs/newrelic-dashboard.json > /tmp/dashboard.json
   ```

2. **Dashboards → Import dashboard**, pega el contenido de `/tmp/dashboard.json` y
   elige la cuenta.

## 9. Verificación rápida

1. **Infrastructure → Hosts**: el host de la EC2 reporta CPU y memoria, y sus
   contenedores (`master`, `connector`, `db`) aparecen como entidades.
2. **APM & Services → energyshark-master**: hay throughput y la tasa de errores
   es cercana a 0.
3. **External services**: aparece `wallet.iic2173.org` con llamadas recientes.
4. `SELECT count(*) FROM WalletCall SINCE 1 hour ago` devuelve más de 0.
5. Las transacciones `/events` y `/market` tienen datos de la última hora.
6. **APM & Services → energyshark-connector** aparece con transacciones *Non-web*.
7. `SELECT count(*) FROM QueueMessage FACET queue SINCE 1 hour ago` muestra las dos
   colas, y `SELECT latest(messages) FROM QueueDepth FACET queue` devuelve datos.

## 10. Logs correlacionables

Toda línea de log que `master` o el `connector` escriben mientras procesan un
mensaje lleva el contexto de ese mensaje, sin pasarlo a mano en cada
`console.log`. Lo hace `log.js` (uno en cada servicio). Al arrancar,
`log.install()` reemplaza `console.log/info/warn/error`. El contexto viaja con
`AsyncLocalStorage` por todo el procesamiento, también a través de los `await`, y
dos mensajes procesados en paralelo no se mezclan.

| Campo | De dónde sale |
| --- | --- |
| `cycleId` | `cycleId` del mensaje |
| `idpk` | `idpk` del mensaje; en `/internal/sagas/:idpk`, el de la ruta |
| `type` | tipo del mensaje (`bid`, `swap-proposed`, …) |
| `swapId` | `data.swapId` |
| `swapIdpk` | `Idempotency-Key` de nuestra operación en la wallet (`data.idpk` de los eventos `swap-*`) |
| `offerId` | `data.offerId` |
| `executionName` | nombre de la ejecución de Step Functions (callbacks de la saga) |
| `msgId`, `cityId` | del mensaje |

Dónde se pone el contexto:

- `master`: un middleware de Express en cada request (`/events`, `/market`,
  `/internal/sagas/...`), y los reintentos de la wallet (`retryPending`) con el
  `swapIdpk` de cada operación.
- `connector`: cada mensaje consumido de `city.REE.q` y `market.REE`, y cada
  publicación por `/publish`.

**En la salida de los contenedores** (`docker compose logs master`) la línea
termina con el contexto:

```
[seller] swap-proposed handler error: ... | cycleId=c-1 idpk=evt-1 type=swap-proposed swapId=sw-1 swapIdpk=op-1
```

Las líneas que ya son JSON, como las de `sagas/resume.js`
(`saga_resume_sent_success`, `saga_resume_token_expired`, …), siguen siendo JSON:
el contexto se agrega adentro y los campos propios de la línea mandan. En esas
líneas, `idpk` es la llave de la operación con la que se guardó el task token.

**En New Relic**, con la license key configurada, cada línea también se envía a
**Logs** con `newrelic.recordLogEvent`. Los campos van como atributos, más
`level`, `component` (`master` o `connector`) y `scope` (la etiqueta entre
corchetes, como `seller`). El log queda enlazado a la transacción APM en curso.
El forwarding de logs del agente está activo por defecto. Si no aparecen logs,
revisa que `NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED` no esté en `false`.

```sql
SELECT timestamp, component, level, message FROM Log WHERE swapId = '<swapId>' SINCE 1 day ago
SELECT timestamp, component, message FROM Log WHERE cycleId = '<cycleId>' AND level = 'ERROR' SINCE 1 day ago
SELECT count(*) FROM Log WHERE level = 'ERROR' FACET scope SINCE 1 hour ago
SELECT count(*) FROM Log WHERE component = 'master-saga-resumer' FACET event SINCE 1 day ago
```

### De un log a la saga

1. Desde la alerta o el error, busca en **Logs** por `swapId` (o `cycleId`).
2. El `idpk` del mensaje que inició la saga es el nombre de la ejecución. Se
   confirma en la base:

   ```sql
   SELECT idpk, execution_name, role, status, reason, started_at, finished_at
   FROM saga_runs WHERE swap_id = '<swapId>' OR swap_idpk = '<swapIdpk>';
   ```

3. En la consola de AWS, **Step Functions → máquina de la saga → Executions**,
   busca por `execution_name`. Ahí está el historial de pasos y la compensación.

Las Lambdas de la saga escriben JSON con los mismos nombres de campo (`cycleId`,
`idpk`, `swapId`, `executionName`), así que la misma búsqueda las encuentra
cuando sus logs llegan a New Relic.

### Logs de las Lambdas en New Relic

Los logs de las Lambdas quedan en CloudWatch. Para verlos en New Relic junto a
los de la EC2, se suscribe cada log group (`/aws/lambda/<función>`) a la función
de envío de logs de New Relic. Esa función se instala con la integración de AWS
(paso hecho en la E3, stack de CloudFormation de New Relic):

**CloudWatch → Log groups → `/aws/lambda/<función>` → Subscription filters →
Create Lambda subscription filter**. Como destino, `NewRelicLogsLoggingLambda`
(o el nombre que tenga en el stack). Deja el patrón vacío para enviar todo.

Si el CDK define el filtro, este paso manual no hace falta.

### Qué no lleva contexto todavía

- El worker del comprador (`buyer/worker.js`), que corre por ciclo fuera de un
  mensaje. Se agrega cuando se rehaga para la saga del comprador (2.3).
- El temporizador de rebaja de precio del vendedor.
- La Lambda `reservar` no incluye `executionName` en sus logs. Las demás sí.
