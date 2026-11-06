# EnergyShark — ciudad REE

Backend del grupo 3 para IIC2173, Arquitectura de Sistemas de Software.

El sistema participa como la ciudad **REE** (Re-Estize) en el mercado
energético del curso (protocolo v3): consume sus dos colas del broker
(`city.REE.q` y `market.REE`), aplica los eventos de la wallet, vende y compra
energía a otras ciudades con swaps y reporta cada ciclo a la central.

| Entorno | URL |
| --- | --- |
| Frontend | https://app.fasantamaria.me |
| API | https://api.fasantamaria.me |
| Servidor directo | https://www.fasantamaria.me |

- Arquitectura y diagrama de componentes → [`docs/arquitectura.md`](docs/arquitectura.md)
- Monitoreo y cómo replicarlo → [`docs/monitoreo.md`](docs/monitoreo.md)
- Decisiones de diseño y post-mortems → [`docs/ADR/`](docs/ADR/)
- Contratos con la central y contract tests → [`contracts/README.md`](contracts/README.md)

---

## Correr en local

### Requisitos

- **Docker** y **Docker Compose v2** (`docker compose`, sin guion).
- **bash, curl y python3** para los scripts de `scripts/` (WSL, macOS o Linux).
- **Node 22**, solo si vas a correr las pruebas o los servicios fuera de los contenedores.

No necesitas credenciales de AWS: el `docker-compose.yml` construye las imágenes
desde el código, no las baja de ECR.

> **No uses en local las credenciales reales del broker ni la API key de la wallet.**
> El connector consumiría las colas reales de REE y le quitaría los mensajes al
> nodo de producción (con multas por reportes que no salen), y con la API key el
> nodo local propondría y aceptaría swaps con la cuenta real de la ciudad.

### Puesta en marcha

Se levantan `master`, `connector`, Postgres y un RabbitMQ propio con la misma
topología que el broker del curso.

**1. Configurar el connector para el broker local:**

```bash
cp connector/local.env.example connector/.env
```

Opcional: `cp .env.example .env` si quieres cambiar algún valor por defecto
(usuario de Postgres, reportes, Auth0). Ambos `.env` están en `.gitignore`.

**2. Levantar los servicios:**

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build -d
```

**3. Crear en RabbitMQ el vhost, los usuarios, los exchanges y las colas:**

```bash
./scripts/broker-local.sh
docker compose restart connector
```

El script crea el vhost `energy`, los exchanges `energy.x` (directo) y `market`
(topic), las colas `city.REE.q`, `market.REE`, `central.q` (lo que mandamos a la
central) y `city.MET.q` (lo que le respondemos a MET), y los usuarios `city.REE`
y `city.MET` con clave `local`. Se reinicia el connector porque al arrancar las
colas todavía no existían.

**4. Comprobar que todo está arriba:**

```bash
docker compose ps
curl http://localhost:3000/health
docker compose logs connector | tail -5
```

`/health` devuelve `"status":"ok"`, y en el log del connector aparecen
`Escuchando la cola "city.REE.q"` y `Escuchando la cola de mercado "market.REE"`.
El log dice `Conectando a broker.iic2173.org` aunque esté usando el broker local:
es solo el texto del mensaje, la conexión real sale de `RABBIT_URL`.

**5. Simular un ciclo:**

`scripts/publicar-local.sh` publica un mensaje como si viniera de la central o de
otra ciudad. En `scripts/mensajes-local/` hay tres de ejemplo:

```bash
./scripts/publicar-local.sh central  scripts/mensajes-local/status-statement.json
./scripts/publicar-local.sh market   scripts/mensajes-local/offer-MET.json
./scripts/publicar-local.sh city.MET scripts/mensajes-local/bid-MET.json
```

Qué debería pasar:

- `master` guarda el `status-statement` y congela la configuración del ciclo.
  Como en local no hay wallet, el vendedor deja `Sin cliente de la wallet: no se
  publica oferta` en el log, que es lo esperado.
- La oferta de MET queda en el libro de mercado.
- El bid de MET recibe un `bid-rejected`, porque no hay oferta nuestra.

Para revisarlo:

```bash
docker compose exec db psql -U energyshark -d energyshark \
  -c "SELECT type, cycle_id FROM events ORDER BY seq DESC LIMIT 5;" \
  -c "SELECT city_id, offer_id, remaining, price_per_energy FROM market_offers;"
```

Las respuestas que publica el nodo (los `ack` a la central y el `bid-rejected` a
MET) se ven en el panel de RabbitMQ, <http://localhost:15672> (usuario `admin`,
clave `admin`), en **Queues → central.q** y **city.MET.q → Get messages**.

Para usar tus propios mensajes, copia uno de los ejemplos. Los campos `idpk`,
`msgId` y `timestamp` con valor `"auto"` se reemplazan al publicar, así cada
publicación es un mensaje nuevo.

### Pruebas

```bash
# master: necesita un Postgres para las pruebas (cada prueba usa su propio schema)
docker run -d --name es-testdb -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16-alpine
cd master && npm ci && TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm test; cd ..
docker rm -f es-testdb

# connector
cd connector && npm ci && npm test; cd ..
```

Las mismas pruebas corren en CI en cada PR y antes de cada deploy
(`.github/workflows/ci.yml`).

### Variables de entorno

| Variable | Dónde | En local | Para qué |
| --- | --- | --- | --- |
| `RABBIT_URL` | `connector/.env` | `amqp://city.REE:local@rabbitmq:5672/energy` | Conexión al broker |
| `RABBIT_QUEUE` | `connector/.env` | `city.REE.q` | Cola de mensajes dirigidos a REE |
| `RABBIT_MARKET_QUEUE` | `connector/.env` | `market.REE` | Feed de mercado |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `.env` | `energyshark` | Base de datos |
| `REPORTS_ENABLED` | `.env` | `false` | Envío del `negotiation-report` a la central |
| `AUTH_REQUIRED` | `.env` | `false` | Exigir token de Auth0 en la API |
| `WALLET_BASE_URL`, `WALLET_API_KEY` | `.env` | vacías | Cliente de la wallet. Sin ellas no se proponen ni aceptan swaps |

### Bajar todo

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml down      # conserva la base
docker compose -f docker-compose.yml -f docker-compose.local.yml down -v   # borra también la base
```

---

## Servicios

| Servicio | Puerto | Qué hace |
| --- | --- | --- |
| `master` | 3000 | API REST, ledger, efectos de la wallet, vendedor, comprador y reportes |
| `connector` | 3001 (interno) | Consume `city.REE.q` y `market.REE`, valida, responde ACK/NACK y publica hacia la central y otras ciudades |
| `db` | 5432 (interno) | PostgreSQL 16 |
| `rabbitmq` | 5672 y 15672 | Solo en local, con `docker-compose.local.yml` |

Postgres no expone puerto hacia tu máquina a propósito. Para entrar:

```bash
docker compose exec db psql -U energyshark -d energyshark
```

## Estructura

```
.
├── master/                     API REST y lógica del nodo
│   ├── ledger/                 eventos recibidos y migraciones
│   ├── wallet/                 cliente de la wallet (Idempotency-Key, reintentos)
│   ├── effects/                eventos de la wallet → saldo local
│   ├── market/                 feed de mercado y selección de ofertas
│   ├── seller/                 vendedor: oferta, bids, swaps propuestos
│   ├── buyer/                  comprador: plan por ciclo, bids, verificación del token
│   ├── config/                 estrategia como configuración (/config)
│   └── reports/                negotiation-report por ciclo
├── connector/                  consumidor y publicador AMQP
├── contracts/                  mensajes reales de la central para los contract tests
├── docs/                       spec, milestones, arquitectura, monitoreo, OpenAPI
│   └── ADR/                    decisiones de diseño y post-mortems
├── scripts/                    broker local y publicación de mensajes de prueba
├── .github/workflows/          ci.yml (pruebas) y deploy.yml (ECR + EC2)
├── docker-compose.yml          local, construye las imágenes
├── docker-compose.local.yml    local, agrega el RabbitMQ propio
└── docker-compose.prod.yml     servidor, consume imágenes de ECR
```
