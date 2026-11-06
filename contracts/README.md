# Contratos con la central (RDOC04)

`central-real.json` guarda mensajes **reales** de la central y de MET sacados de producción. Los usan:

- `connector/test/contract.test.js`: cada mensaje tiene que pasar la validación del connector.
- `master/test/contract.test.js`: el código tiene que interpretarlos como la central (por ejemplo, el transporte calculado tiene que ser igual al `transportPerEnergy` que cobró la central) y lo que publicamos tiene que cumplir el protocolo.

Las dos suites corren en CI (`.github/workflows/ci.yml`) en cada PR y antes de cada deploy.

Si la central cambia un formato, regenera el archivo con el comando de abajo y corre las pruebas: una prueba de contrato que falla es una diferencia real entre nuestro código y la central.

## Regenerar `central-real.json`

En la EC2, desde `~/energyshark`:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' > ~/central-real.json <<'SQL'
WITH m AS (
  SELECT DISTINCT ON (type) type, received_at, jsonb_build_object(
    'idpk', idpk, 'msgId', msg_id, 'type', type, 'sender', 'central', 'cycleId', cycle_id,
    'timestamp', to_char(COALESCE(published_at, received_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', CASE WHEN type = 'swap-proposed' THEN (package_body - 'token') || '{"token":"omitido"}'::jsonb ELSE package_body END
  ) AS msg
  FROM events
  WHERE type IN ('status-statement', 'transfer', 'imbalance-settlement', 'swap-proposed', 'swap-settled')
     OR (type = 'trade-recorded' AND package_body->>'seller' = 'REE')
  ORDER BY type, received_at DESC
), dt AS (
  SELECT jsonb_build_object(
    'idpk', e.idpk, 'msgId', e.msg_id, 'type', e.type, 'sender', 'central', 'cycleId', e.cycle_id,
    'timestamp', to_char(COALESCE(e.published_at, e.received_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', e.package_body) AS msg
  FROM events e
  WHERE e.type = 'distance-table'
    AND e.received_at <= COALESCE((SELECT received_at FROM m WHERE type = 'trade-recorded'), now())
  ORDER BY e.received_at DESC LIMIT 1
), rej AS (
  SELECT last_result AS msg FROM buyer_bids WHERE last_result->>'type' = 'swap-rejected' ORDER BY updated_at DESC LIMIT 1
), ofe AS (
  SELECT payload FROM market_feed WHERE city_id = 'MET' AND type = 'offer' ORDER BY received_at DESC LIMIT 1
), bid AS (
  SELECT raw_payload FROM seller_bids WHERE buyer_city_id = 'MET' ORDER BY created_at DESC LIMIT 1
)
SELECT jsonb_pretty(
  jsonb_build_object('_nota', 'Mensajes reales de la central y de MET sacados de producción el ' || to_char(now(), 'YYYY-MM-DD') || '. Se regenera con el comando de contracts/README.md.')
  || COALESCE((SELECT jsonb_object_agg(type, jsonb_build_object('cola', 'city', '_fuente', 'events (último de su tipo)', 'mensaje', msg)) FROM m), '{}')
  || COALESCE((SELECT jsonb_build_object('distance-table', jsonb_build_object('cola', 'city', '_fuente', 'events (vigente al trade-recorded)', 'mensaje', msg)) FROM dt), '{}')
  || COALESCE((SELECT jsonb_build_object('swap-rejected', jsonb_build_object('cola', 'city', '_fuente', 'buyer_bids.last_result', 'mensaje', msg - 'receivedAt' - 'routingKey')) FROM rej), '{}')
  || COALESCE((SELECT jsonb_build_object('offer-MET', jsonb_build_object('cola', 'market', 'routingKey', payload->>'routingKey', '_fuente', 'market_feed', 'mensaje', payload - 'receivedAt' - 'routingKey')) FROM ofe), '{}')
  || COALESCE((SELECT jsonb_build_object('bid-MET', jsonb_build_object('cola', 'city', 'userId', 'city.MET', '_fuente', 'seller_bids.raw_payload', 'mensaje', raw_payload - 'receivedAt' - 'userId')) FROM bid), '{}')
);
SQL
head -c 400 ~/central-real.json
```

Después, desde tu computador:

```bash
scp -i <tu .pem> ubuntu@www.fasantamaria.me:~/central-real.json contracts/central-real.json
```

El token del `swap-proposed` se reemplaza por `"omitido"`. Los mensajes no traen API keys ni credenciales, pero revisa el archivo antes de commitearlo.
