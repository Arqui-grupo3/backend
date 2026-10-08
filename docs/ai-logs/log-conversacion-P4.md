## 1. Identificación del rol P4

Se revisaron el enunciado de E1, el roadmap y el backend existente. Las responsabilidades
identificadas para P4 fueron:

- API REST JSON para RF01, RF02, RF04 y RF05.
- Publicación hacia la central mediante `energy.x` y routing key `central`.
- Integración con Auth0/JWK y API Gateway.
- Configuración de CORS.
- OpenAPI y repositorio de contratos.
- Coordinación con P1 para API Gateway y con P5 para el contrato de la API.

## 2. Instalación y ejecución inicial

Se detectó que la raíz del repositorio no tiene `package.json`. Los servicios tienen
dependencias independientes:

```bash
cd ~/backend/master
npm install

cd ../connector
npm install
```

La forma recomendada de ejecutar el proyecto es:

```bash
cd ~/backend
docker compose up -d --build
```

También se explicó que `npm start` debe ejecutarse dentro de `master` o `connector`,
no dentro de `~/backend`.

## 3. PostgreSQL y Docker

Se corrigieron problemas de permisos y configuración de Docker Desktop/WSL. Se verificó
que PostgreSQL quedara disponible mediante Docker Compose y que `master` pudiera crear
la tabla `events`.

Comandos utilizados:

```bash
docker compose ps
docker compose logs -f db master
curl http://localhost:3000/health
```

## 4. Implementación de P4

Se agregaron o mejoraron las siguientes funcionalidades:

### RF01

- `GET /history`
- `GET /history/:id`
- `GET /cycles`
- `GET /cycles/:cycleId`
- Filtros por ciclo, tipo y fecha.
- Paginación con límite máximo de 100.
- Campo `lastOperation`.
- Resumen consolidado por ciclo:
  - status statements;
  - transfers;
  - demand statements;
  - negociaciones;
  - negotiation reports;
  - balances finales;
  - última operación.

### RF02

- `GET /connectivity`
- Devuelve la última `distance-table` persistida.

### RF04

- `GET /negotiations`
- `POST /negotiations`
- Publicación de propuestas a través del connector.
- Estados derivados de los eventos:
  - `pending`;
  - `confirmed`;
  - `paid`;
  - `expired`;
  - `failed`.

### RF05

- Nueva tabla `api_audit`.
- `GET /audit`
- Filtros:
  - `DUPLICATE_IDPK`;
  - `DISCARDED`;
  - `NACK`.
- Registro de duplicados sin reaplicar el evento.
- Registro de mensajes descartados por JSON inválido, ausencia de `msgId` o routing key
  inesperada.
- Registro de mensajes que reciben NACK.

## 5. Connector y RabbitMQ

El connector fue ampliado para:

- Mantener el consumo de `city.REE.q`.
- Persistir eventos válidos mediante `POST /events`.
- Publicar ACK/NACK.
- Registrar descartes y NACK en la auditoría.
- Exponer una API interna de publicación en el puerto `3001`.
- Publicar propuestas hacia la central mediante `energy.x` y routing key `central`.
- Escribir un heartbeat para el healthcheck.

El flujo esperado es:

```text
RabbitMQ → connector → master → PostgreSQL → API REST
```

Para RF04:

```text
Postman → master → connector → energy.x/central → RabbitMQ
```

## 6. Problemas resueltos

- `npm install` ejecutado en una carpeta sin `package.json`.
- Docker no disponible inicialmente dentro de WSL.
- Permisos insuficientes para `/var/run/docker.sock`.
- PostgreSQL no disponible antes de levantar Docker Compose.
- Error de compatibilidad de New Relic con Node 20.
- `CORS_ORIGIN` utilizado antes de su declaración.
- Healthcheck del connector en estado `unhealthy` por falta de heartbeat.
- Archivo generado `master/newrelic_agent.log` removido del seguimiento de Git.

## 7. Estado verificado

Se verificó que los siguientes servicios quedaran operativos:

```text
db         healthy
master     healthy
connector  healthy
```

Se probaron los endpoints:

```text
GET  /health
GET  /history
GET  /cycles
GET  /connectivity
GET  /negotiations
GET  /audit
POST /events
```

La conexión RabbitMQ fue confirmada mediante los logs:

```text
[connector] Escuchando la cola "city.REE.q"...
[connector] API interna de publicación en 3001
```

También se observó que el connector puede reconectarse después de una desconexión.

## 8. New Relic

New Relic sirve para monitorear requests, errores, rendimiento e infraestructura.
La API funciona sin una licencia configurada, pero no se envían métricas al panel.

Para producción se debe configurar localmente, sin subir secretos:

```env
NEW_RELIC_LICENSE_KEY=...
NEW_RELIC_APP_NAME=energyshark-master
```

## 9. Pendientes

- Configurar una licencia válida de New Relic en el entorno de producción.
- Configurar y verificar API Gateway, dominio HTTPS y authorizer Auth0.
- Implementar o integrar el frontend SPA.
- Confirmar el flujo completo RF03, que corresponde principalmente al ledger de P3.
- Probar un ciclo completo con eventos reales de la central.
- Mantener los secretos fuera del repositorio y solicitar rotación de credenciales que hayan
  sido expuestas.

## 10. Archivos principales modificados

- `master/index.js`
- `master/Dockerfile`
- `master/.gitignore`
- `connector/index.js`
- `docker-compose.yml`
- `docs/openapi.yaml`
- `master/README.md`

## 11. Prompts y flujos relevantes

Esta sección reconstruye los prompts principales de la conversación y los flujos
técnicos asociados. No es una transcripción literal completa y no contiene
credenciales, tokens ni claves privadas.

### Prompts principales

#### Identificación del rol

> ¿Me puedes ayudar con el rol de P4?

Se utilizó para identificar las responsabilidades de P4: API REST, autenticación,
API Gateway, CORS, OpenAPI y coordinación con los demás roles.

#### Instalación y ejecución

> `npm install` falla porque no encuentra `package.json`.

La solución fue ejecutar la instalación dentro de `master` y `connector`, o levantar
el stack completo con Docker Compose.

#### Disponibilidad de PostgreSQL

> Me sale postgres no disponible.

Se verificaron Docker Desktop, la integración con WSL, permisos del socket Docker,
el estado de PostgreSQL y la conectividad de `master` con la base de datos.

#### Implementación de requisitos

> ¿Me ayudas a implementar RF1, 2, 4 y 5?

Este prompt inició la implementación de:

- historial y detalle de ciclos;
- tabla de conectividad;
- creación y seguimiento de negociaciones;
- auditoría de duplicados, descartes y NACK.

#### Integración con RabbitMQ

> ¿Funciona con los eventos de RabbitMQ?

Se verificó el flujo del connector, la cola de la ciudad, la publicación hacia la
central y la persistencia de eventos en `master`.

#### Verificación

> ¿Cómo puedo confirmar que está funcionando correctamente?

Se definieron verificaciones mediante Docker Compose, logs, healthchecks, endpoints
REST, PostgreSQL y RabbitMQ.

### Flujo de RF01: historial de ciclos

```text
Evento recibido
    ↓
POST /events
    ↓
Validación y persistencia en PostgreSQL
    ↓
Agrupación por cycleId
    ↓
GET /cycles o GET /cycles/:cycleId
    ↓
Historial consolidado con lastOperation
```

La respuesta consolida `status-statement`, `transfer`, `demand-statement`,
negociaciones, `negotiation-report`, balances finales y la última operación
aplicada.

### Flujo de RF02: conectividad

```text
distance-table recibida
    ↓
Validación del contenido
    ↓
Persistencia de la actualización
    ↓
GET /connectivity
    ↓
Última distance-table vigente
```

La tabla expone destino, distancia, `transportCost` y `enabled`.

### Flujo de RF04: negociación voluntaria

```text
Cliente o Postman
    ↓
POST /negotiations
    ↓
master
    ↓
API interna del connector
    ↓
RabbitMQ: energy.x / central
    ↓
Central
```

El seguimiento de eventos permite derivar los estados `pending`, `confirmed`,
`paid`, `expired` y `failed`.

### Flujo de RF05: duplicados, descartes y NACK

```text
Mensaje RabbitMQ
    ↓
Validación del connector
    ├── JSON inválido o msgId ausente → DISCARDED
    ├── envelope inválido             → NACK
    ├── idpk ya procesado             → DUPLICATE_IDPK
    └── mensaje válido                → POST /events y ACK
```

Los duplicados se registran en la auditoría, pero no se reaplican al ledger local.
Los resultados se consultan mediante `GET /audit`.

### Flujo completo de mensajería

Entrada desde la central:

```text
RabbitMQ → energy.x → city.REE → city.REE.q
         → connector → master → PostgreSQL → API REST
```

Salida hacia la central:

```text
API REST → master → connector → energy.x → central → RabbitMQ
```

### Flujo de verificación local

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/health
curl http://localhost:3000/history
curl http://localhost:3000/cycles
curl http://localhost:3000/connectivity
curl http://localhost:3000/negotiations
curl http://localhost:3000/audit
docker compose logs --tail=30 connector master
```

El estado esperado es `healthy` para `db`, `master` y `connector`. En los logs del
connector debe aparecer que escucha `city.REE.q` y que su API interna está
disponible en el puerto `3001`.
