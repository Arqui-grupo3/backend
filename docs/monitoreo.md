# Monitoreo — pasos para replicar

EnergyShark · ciudad REE · cubre RNF05 y G07.

Son dos agentes independientes: el de **infraestructura** mide el host (CPU,
memoria, contenedores) y el de **APM** mide la aplicación (peticiones, latencia,
errores, SQL). Hacen falta los dos.

## Llaves

New Relic usa dos:

| Llave | Forma | Uso |
| --- | --- | --- |
| License key | termina en `NRAL` | el agente envía datos |
| User key | empieza con `NRAK-` | el instalador habla con la API |

Ambas en **Administration → API keys**. La User key hay que crearla:
**Create a key → Key type: User**.

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

```bash
cd master && npm install newrelic
```

Primera línea de `master/index.js`, antes de cualquier otro `require`:

```js
require('newrelic');
```

El orden importa: el agente instrumenta `express` y `pg` parchándolos al
cargarse. Si ya fueron importados, las trazas salen vacías.

En el servicio `master` de `docker-compose.prod.yml`:

```yaml
    environment:
      NEW_RELIC_LICENSE_KEY: ${NEW_RELIC_LICENSE_KEY}
      NEW_RELIC_APP_NAME: energyshark-master
      NEW_RELIC_LOG: stdout
```

La license key vive en el `.env` del servidor, nunca en el repositorio.

Push a `main` para desplegar, y verifica:

```bash
docker compose -f docker-compose.prod.yml logs master | grep -i newrelic
curl https://www.fasantamaria.me/health
```

Aparece en **APM & Services** como `energyshark-master` a los dos minutos.