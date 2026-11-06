# Monitoreo — pasos para replicar

EnergyShark · ciudad REE · cubre RDOC03 (pasos de monitoreo), RNF05 y G08.

En la E2 el monitoreo cubre cuatro cosas: el host, la aplicación (`master`), las
llamadas a la wallet y el feed de mercado. Todo llega a una sola cuenta de
New Relic.

| Qué se mide | Cómo | Dónde se ve en New Relic |
| --- | --- | --- |
| Host y contenedores de la EC2 | Agente de infraestructura | **Infrastructure → Hosts** |
| `master`: peticiones HTTP, latencia, errores y SQL | Agente APM de Node | **APM & Services → energyshark-master** |
| Llamadas a la wallet: latencia, estado y motivo | APM (servicio externo) + evento propio `WalletCall` | **External services → wallet.iic2173.org** y consultas NRQL |
| Feed de mercado: mensajes recibidos de `market.REE` | APM: transacción `POST /market` de `master` | **Transactions** y consultas NRQL |
| Entrega de mensajes del connector a `master` | APM: transacción `POST /events` | **Transactions** y la alerta del paso 6 |

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

## 3. Llamadas a la wallet

El agente APM registra cada llamada HTTP a `wallet.iic2173.org` como servicio
externo. Además, el cliente de la wallet (`master/wallet/index.js`) registra cada
llamada como un evento propio, `WalletCall`, con estos atributos:

| Atributo | Contenido |
| --- | --- |
| `operation` | `propose`, `accept`, `cancel`, `balance`, `statement`, `swap`, … |
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

## 4. Feed de mercado

El connector consume `market.REE` y entrega cada oferta, `offer-updated`,
`offer-withdrawn` y `market-closed` a `master` por `POST /market`. Cada entrega es
una transacción del APM de `master`:

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

Lo que el connector descarta antes de entregarlo (routing key inesperada,
identidad que no calza) queda en su log como `Mensaje de mercado descartado` y en
la tabla `api_audit` de la base.

## 5. Mensajes de la central (`city.REE`)

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

## 6. Alertas

En **Alerts → Alert conditions → New alert condition → Write your own query**,
dentro de la política `EnergyShark - operación`:

| Condición | Consulta | Umbral |
| --- | --- | --- |
| Connector sin entregar mensajes | `SELECT count(*) FROM Transaction WHERE appName = 'energyshark-master' AND request.uri = '/events'` | Ventana de 5 min, **rellenar huecos con 0**, crítica si es **menor que 1 durante 25 min**; pérdida de señal a los 25 min |
| Errores de la wallet | `SELECT count(*) FROM WalletCall WHERE status >= 500 OR status = 429 OR status = 0` | Ventana de 5 min, crítica si es **mayor que 3 al menos una vez en 5 min** |

Sin el relleno con 0, la primera condición nunca se dispara: si el connector se
cae no llegan datos, y "menor que 1" no se evalúa sobre una serie vacía.

Para recibir los avisos por correo: **Alerts → Workflows → Add a workflow**, filtro
*Policy = EnergyShark - operación*, destino *Email*. Sin workflow los incidentes
igual quedan en **Alerts → Issues & activity**. Para probarlo sin botar el nodo,
usa **Test workflow**.

## 7. Verificación rápida

1. **Infrastructure → Hosts**: el host de la EC2 reporta CPU y memoria, y sus
   contenedores (`master`, `connector`, `db`) aparecen como entidades.
2. **APM & Services → energyshark-master**: hay throughput y la tasa de errores
   es cercana a 0.
3. **External services**: aparece `wallet.iic2173.org` con llamadas recientes.
4. `SELECT count(*) FROM WalletCall SINCE 1 hour ago` devuelve más de 0.
5. Las transacciones `/events` y `/market` tienen datos de la última hora.
