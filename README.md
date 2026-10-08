# EnergyShark — ciudad REE

Backend del grupo 3 para IIC2173, Arquitectura de Sistemas de Software.

El sistema participa como la ciudad **REE** (Re-Estize) en el mercado
energético del curso: consume mensajes del broker, mantiene un ledger
append-only de los ciclos, negocia con otras ciudades y reporta a la central.

| Entorno | URL |
| --- | --- |
| Frontend | https://app.fasantamaria.me |
| API | https://api.fasantamaria.me |
| Servidor directo | https://www.fasantamaria.me |

- Arquitectura y diagrama de componentes → [`docs/arquitectura.md`](docs/arquitectura.md)
- Monitoreo y cómo replicarlo → [`docs/monitoreo.md`](docs/monitoreo.md)
- Decisiones de diseño → los archivos `docs/ADR-*.md`

---

## Requisitos

- **Docker** y **Docker Compose v2** (`docker compose`, sin guion)
- **Node 20+**, solo si vas a trabajar fuera de los contenedores
- Las credenciales del broker, que **no están en el repositorio**. Pídeselas a
  P1 o sácalas del enunciado del curso.

No necesitas credenciales de AWS para correr el proyecto en local: el
`docker-compose.yml` construye las imágenes desde el código, no las baja de ECR.

---

## Puesta en marcha

**1. Clonar:**

```bash
git clone git@github.com:Arqui-grupo3/backend.git
cd backend
```

**2. Crear `connector/.env`** con las credenciales del broker. Este archivo está
en `.gitignore` y nunca debe commitearse:

```bash
cp connector/.env.example connector/.env
```

Si no existe el `.example`, créalo a mano. Los nombres exactos de las variables
los define `connector/index.js`; para verlos:

```bash
grep -o "process\.env\.[A-Z_]*" connector/index.js | sort -u
```

**3. Levantar todo:**

```bash
docker compose up --build
```

La primera vez demora unos minutos construyendo las imágenes. Cuando veas que
`master` dice que escucha en el puerto 3000 y que `connector` se conectó al
broker, está listo.

**4. Comprobar que responde:**

```bash
curl http://localhost:3000/health
```

Debe devolver un JSON con `status`, `uptime` y el conteo de filas del ledger.

---

## Servicios

| Servicio | Puerto | Qué hace |
| --- | --- | --- |
| `master` | 3000 | API REST y única pieza que escribe en el ledger |
| `connector` | — | Consume de `city.REE.q` y publica hacia la central |
| `db` | 5432 (interno) | PostgreSQL 16 |

Postgres no expone puerto hacia tu máquina a propósito. Para entrar:

```bash
docker compose exec db psql -U energyshark -d energyshark
```

---

## Comandos frecuentes

```bash
# logs de un servicio
docker compose logs -f master

# reconstruir solo master tras cambiar su código
docker compose up -d --build master

# ver las últimas filas del ledger
docker compose exec db psql -U energyshark -d energyshark \
  -c "SELECT seq, type, cycle_id, received_at FROM events ORDER BY seq DESC LIMIT 10;"

# bajar todo conservando los datos
docker compose down
```

> **Nunca corras `docker compose down -v`.** La `-v` borra el volumen de
> Postgres y con él todo el ledger. En el servidor eso significa perder las más
> de 100.000 filas acumuladas desde la Entrega 0.

---


## Estructura

```
.
├── master/                  API REST, lógica del ledger, worker de vencimientos
├── connector/               consumidor y publicador AMQP
├── docs/
│   ├── arquitectura.md
│   ├── monitoreo.md
│   ├── diagramas/
│   └── ADR-*.md             decisiones de diseño
├── scripts/
│   └── deploy-remoto.sh     lo ejecuta systemd en la EC2
├── docker-compose.yml       local, construye las imágenes
└── docker-compose.prod.yml  servidor, consume imágenes de ECR
```

---