# Master POC - EnergyShark (Entrega 0, punto 2 del roadmap)

Servidor HTTP (Express) que recibe eventos desde `connector` vía POST y los
deja disponibles para consulta. Por ahora guarda todo **en memoria** (se
pierde al reiniciar) — la base de datos real (Postgres/Mongo, RNF6) se
integra en un paso posterior del roadmap.

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
  del broker. Body: el evento tal cual (`idpk`, `type`, `packageBody`, y
  opcionalmente `receivedAt`).
- `GET /history?page=1&limit=25` — historial paginado (RF1 + RF3).
- `GET /history?receivedAt=2026-08-27` — filtro por propiedades, con
  matching especial por fecha (prefijo `YYYY-MM-DD`) para campos de tiempo
  (RF4).
- `GET /history/:id` — detalle de un registro por su `id` (RF2).

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
5. Reemplazar el almacenamiento en memoria por Postgres/Mongo.
6. EC2 + Docker + DNS + Nginx.
