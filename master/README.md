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
    "idpk": "test-1234",
    "type": "demand-set",
    "packageBody": {
      "demands": [{ "city": "Los Santos", "demand": 100, "unit": "GW" }]
    }
  }'

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
