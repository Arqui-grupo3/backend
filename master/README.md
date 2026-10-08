# Master API - EnergyShark (Entrega 1)

Servidor HTTP (Express) que recibe eventos v2 desde `connector` vía POST y los
persiste en Postgres para exponerlos como API JSON.

## Uso

```bash
npm install
cp .env.example .env   # opcional, PORT=3000 por default
npm start
```

Deberías ver:

```
[master] Escuchando en http://localhost:3000
```

## Endpoints

- `GET /health` — para el HEALTHCHECK del container más adelante (RNF7).
- `POST /events` — usado por `connector` para entregar cada evento recibido
  del broker. Body: envelope v2 (`idpk`, `msgId`, `type`, `timestamp`, `data`).
- `GET /history?page=1&limit=25` — historial paginado (RF01).
- `GET /history?cycleId=cycle-9431&type=transfer` — filtros de historial.
- `GET /connectivity` — ultima `distance-table` recibida (RF02).
- `GET /negotiations?limit=25` — propuestas, confirmaciones, pagos y errores (RF04).
- `GET /audit?reason=DUPLICATE_IDPK` — auditoría paginada de duplicados y mensajes
  descartados/rechazados (RF05).
- `GET /history?receivedAt=2026-08-27` — filtro por propiedades, con
  matching especial por fecha (prefijo `YYYY-MM-DD`) para campos de tiempo
  (RF4).
- `GET /history/:id` — detalle de un registro por su `id`.
- `GET /cycles` y `GET /cycles/:cycleId` — resumen consolidado de RF01.
- `POST /negotiations` — crea una propuesta y la publica hacia la central (RF04).

Los listados limitan `limit` a 100 elementos. `/history` agrega
`lastOperation=true` al último evento persistido de cada ciclo.

La especificacion completa esta en `../docs/openapi.yaml`.

## Auth0

En produccion, `AUTH_REQUIRED=true` protege las rutas de consulta con un JWT
RS256. Configura `AUTH0_ISSUER`, `AUTH0_AUDIENCE` y opcionalmente
`AUTH0_JWKS_URL`. El endpoint interno `POST /events` no usa este middleware
porque solo lo invoca el connector dentro de la red privada.

## Probarlo manualmente (sin el connector corriendo)

En una terminal, con el servidor corriendo, en otra:

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "idpk": "a5555555-5555-4555-8555-555555555555",
    "msgId": "b6666666-6666-4666-8666-666666666666",
    "sender": "central",
    "type": "status-statement",
    "timestamp": "2026-10-07T12:00:00Z",
    "cycleId": "cycle-example",
    "data": {
      "energy": { "generationCapacity": 100, "consumption": 120, "generationCost": 2.5 },
      "validUntil": "2026-10-07T12:20:00Z"
    }
  }'

curl "http://localhost:3000/cycles/cycle-example/ledger"
curl "http://localhost:3000/history"
curl "http://localhost:3000/history?page=1&limit=10"
curl "http://localhost:3000/history/<id-que-te-devolvio-el-POST>"
```

## Qué sigue

1. ✅ Connector: conectarse al broker y leer eventos.
2. ✅ Este servicio (`master`): recibir eventos vía POST y exponerlos por
   API.
3. Correr ambos juntos: `connector` ahora hace POST a `master` en vez de
   solo loguear (ver `connector/.env` → `MASTER_URL`).
4. Dockerizar ambos servicios.
5. Conectar API Gateway con el authorizer Auth0.
6. Publicar la SPA y API con HTTPS.

## Ledger de Fase 1

La implementación y sus decisiones están explicadas en
[`../docs/ledger-fase1.md`](../docs/ledger-fase1.md).

- `POST /events` guarda el historial y aplica `status-statement` / `transfer` / `demand-statement`
  recibidos dentro de la misma transacción. Devuelve `ledgerApplied` en una
  inserción nueva. Los otros tipos quedan en historial sin efecto contable todavía.
- `GET /cycles/:cycleId/ledger` expone la proyección con el middleware Auth0
  existente. No modifica los contratos previos de `/cycles` ni `/history`.
- La migración aditiva se ejecuta al iniciar el servidor. No importa eventos
  antiguos: la base del presupuesto comienza en cero al instalar el ledger.
  Antes de desplegar se debe acordar una base histórica verificable; este estado
  parcial no sustituye los balances completos de RF03.

### Pruebas con PostgreSQL 16

Usa una base de pruebas y un usuario con permiso para crear esquemas:

```sh
TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/energyshark_test npm test
```

La suite exige esa variable explícita, crea un esquema aleatorio, inicia el
servidor HTTP real y borra únicamente ese esquema al terminar. No usa el broker,
AWS, Auth0 ni una base de producción. Prueba migración desde E0, duplicados
concurrentes, decimales, orden de llegada, rollback y reinicio del proceso.

## Demandas y reportes P3

Ver [guía de demandas y reportes](../docs/p3-demand-report.md) para ejemplos,
estados y pruebas. `GET /cycles/:cycleId/report` muestra cada intento y su
respuesta; los intentos están en `report_attempts`, separados del historial
de mensajes entrantes. El frontend aún no consume esta ruta.

El envío automático se controla con `REPORTS_ENABLED` (default `false`).
Además exige `LEDGER_BASELINE_CONFIRMED=true`: esta bandera es una declaración
del operador después de reconciliar el saldo inicial, no calcula ni importa
ese saldo. No activar con contabilidad incompleta. El worker bloquea trabajos
si detecta propuestas/confirmaciones voluntarias en el historial, ya que su
efecto contable todavía no está implementado.

`/health` incluye `reporter.enabled`, `lastTick` y `lastError`. Una falla o
un worker habilitado sin actividad por 60 segundos produce HTTP 503. Fallos
de publicación y estados bloqueados se consultan por la ruta de reportes.
