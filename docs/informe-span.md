# Informe del experimento de span (RDOC05)

Responsable: P2 (comprador y estrategia). Relacionado: RF06, ADR AD6 ([ADR-estrategia_como_configuracion.md](ADR/ADR-estrategia_como_configuracion.md)), [post-mortem del incidente del 27-10](ADR/postmortem-AD1-AD3.md#incidente-de-producción--nodo-sin-persistir-del-27-10-al-05-11).

> Resumen honesto: **el experimento planeado no se pudo correr.** El comprador nunca liquidó una compra en el periodo de puntaje, el span quedó fijo en 420 s hasta el 05-11 y el nodo no persistió nada entre el 27-10 y el 05-11. Lo que sí podemos responder viene de reconstruir el libro de ofertas desde el feed de mercado (sección 5). Abajo explicamos qué probamos, qué medimos y por qué no podemos concluir lo que queríamos.

Datos de producción consultados el 05-11 con [`informe-span-consultas.sql`](informe-span-consultas.sql) y [`diagnostico-comprador.sql`](diagnostico-comprador.sql). Periodo de puntaje: desde el 25-10 13:00 (Santiago).

## 1. Pregunta

El **span** es cuánto espera nuestro comprador, desde `opensAt`, antes de enviar su bid. Queríamos saber **qué span minimiza lo que pagamos por cubrir el déficit sin dejar déficit sin cubrir**.

- **Esperar abarata:** MET ofrece a `0.9 × imbalancePrice` y baja cada 60 s hasta `1.1 × buybackPrice` en `lastOfferAt` (T+8:30). Los demás vendedores tienen el mismo incentivo.
- **Esperar arriesga:** otros compradores se llevan el `remaining` barato y queda menos margen antes de `lastBidAt` (T+9:00) para reintentar. Cada kWh no cubierto se paga a `imbalancePrice`.

Hipótesis inicial: un span cercano a 6–7 min captura casi toda la baja de MET sin perder cobertura. Por eso partimos en 390 s y luego en 420 s.

## 2. Qué valores probamos y en qué ciclos

El span es `strategy_config.span_seconds`. Se cambia sin redeploy, cada ciclo congela su versión en `cycle_config` y el comprador guarda esa versión en `buyer_cycles` (ADR AD6).

| Span | Versión de config | Ciclos del comprador | Con déficit | Periodo |
| ---: | --- | ---: | ---: | --- |
| 420 s | `sv-1` (antes de la migración 014) y 4 | 377 | 146 | 25-10 16:25 → 05-11 20:45 UTC |
| 120 / 300 / 480 s | 5 en adelante (`cron-experimento-span`) | — | — | desde 05-11 21:05 UTC; no genera bids (ver 4.2, punto 3), por eso se reemplazó por el contrafactual de la sección 5 |

Historial de la configuración (`strategy_config`):

| Versión | Span | price_factor | Quién | Nota |
| ---: | ---: | ---: | --- | --- |
| 1 | 390 | 0.85 | — | valores iniciales |
| 2 | 390 | 0.50 | ec2-manual | MET no cubre el CR a 0.85 (`INSUFFICIENT_ASSET`) |
| 3 | 390 | 0.60 | ec2-manual | probar 0.6 |
| 4 | 420 | 0.60 | migracion-014 | unifica la config del comprador |
| 5+ | 120 → 300 → 480 | 0.60 | cron-experimento-span | rotación ciclo a ciclo |

Los cambios de las versiones 2 y 3 fueron al precio del **vendedor**, no al span. Hasta el 05-11 el span nunca varió: **no hubo experimento en el periodo en que el comprador podía operar**.

Los 377 ciclos no son continuos: faltan los ciclos 249303 a 249731 (27-10 al 02-11), que el nodo nunca persistió, y los ciclos 249732 a 249947 se procesaron tarde, fuera de su ventana (ver sección 4.3).

## 3. Métricas planeadas

| Métrica | Definición | Fuente |
| --- | --- | --- |
| Span configurado / efectivo | versión congelada del ciclo / primer bid publicado − `opensAt` | `buyer_cycles`, `buyer_bid_attempts` |
| Cobertura | kWh liquidados / `ceil(déficit)` | `buyer_bids` |
| Costo real | compras (acotadas a `imbalancePrice`) + transporte + kWh no cubiertos × `imbalancePrice` | `wallet_effects` |
| Ahorro relativo | Σ (baseline − costo real) / Σ baseline, con baseline = déficit × `imbalancePrice` | misma normalización que el leaderboard |
| Bids rechazados | bid rechazado por el vendedor o aceptación rechazada por la wallet | `buyer_bids` |

## 4. Qué observamos

### 4.1 Resultado con span 420 s: cobertura 0 %

| Ciclos con déficit | Cobertura | Ahorro relativo | Bids enviados | Bids rechazados | Ciclos sin compra | imbalancePrice prom. |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 146 | 0.0 % | 0.0 % | 21 | 14 | 146 | 279.47 |

Todo el déficit se pagó a `imbalancePrice`. Con cobertura 0 en todos los ciclos, el ahorro no distingue entre spans: no hay variación que medir.

### 4.2 Por qué el comprador no compró

1. **25-10 al 26-10 21:45 UTC: el comprador no envió bids.** La primera versión rechazaba todas las ofertas. Pagamos todo el déficit de esos ciclos a 3× y el saldo cayó muy por debajo de la línea de crédito.
2. **26-10 21:45 al 27-10 15:52 UTC: 21 bids, 0 compras.** Los vendedores sí nos aceptaron: hubo 21 `bid-accepted`.
   - **14 aceptaciones fallaron con `INSUFFICIENT_ASSET`.** Al aceptar, la wallet retiene nuestros CR. Nuestro saldo estaba entre −2.4 M y −27.6 M CR, y la línea de crédito entre 0.5 k y 4.7 M: siempre fuera de la línea, así que la wallet rechazó toda aceptación.
   - **7 bids se descartaron** con "El swap no corresponde al bid o está vencido": el swap propuesto no calzaba con el bid o expiró (máximo 60 s) antes de procesarlo.
3. **Desde el 27-10 (`fix/buyer-presupuesto`), el comprador no envía bids** si el saldo más la línea de crédito no alcanza para `minBid`. Es lo correcto (no tiene sentido pedir algo que la wallet va a rechazar), pero significa que con nuestro saldo ningún span puede producir un bid.
4. **27-10 21:45 al 05-11 20:53 UTC: el nodo no persistió nada** (post-mortem del incidente).

Los precios que alcanzamos a pedir con span 420 s fueron de **54.66 a 142.44 CR/kWh** (sin transporte), frente a un `imbalancePrice` cercano a 280: entre 20 % y 51 % del costo de no comprar. Si esas compras se hubieran liquidado, el ahorro habría sido grande. El problema no fue el span sino el crédito.

### 4.3 Atribución (ADR AD6)

- De los 17 ciclos con bids, en 14 el primer bid salió entre 420 y 428 s, pegado al span configurado. En 3 ciclos (249238, 249248, 249260) salió entre 485 y 487 s; los tres fueron bids a HGW. No tenemos registro que explique ese minuto de atraso: puede ser la recuperación por remanente (PR #41) o el worker esperando la oferta, pero no lo verificamos.
- Cada ciclo quedó atribuido a una sola versión de configuración, también los procesados tarde. La atribución de AD6 funcionó aun cuando el resto no.

## 5. Contrafactual: qué había en el libro en cada span

Como el comprador no puede comprar, reconstruimos desde `market_feed` (todas las ofertas que recibimos por `market.REE`) el estado del libro en `opensAt + s` para cada ciclo con déficit y cada span candidato. Esto responde la pregunta de fondo sin depender de nuestro saldo.

| Span candidato | Ciclos | Ofertas vivas prom. | Mejor precio prom. | Precio MET prom. | % de imbalancePrice | % ciclos en que el libro cubre el déficit | Ciclos sin ofertas |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60 s | 106 | 1.5 | 192.34 | 253.97 | 68.5 % | 77.4 % | 5 |
| 120 s | 106 | 1.5 | 174.41 | 230.26 | 62.0 % | 72.6 % | 10 |
| 180 s | 107 | 1.5 | 159.11 | 206.54 | 56.5 % | 71.0 % | 10 |
| 240 s | 107 | 1.5 | 143.80 | 182.83 | 51.1 % | 71.0 % | 10 |
| 300 s | 107 | 1.5 | 128.40 | 159.12 | 45.7 % | 71.0 % | 10 |
| 360 s | 107 | 1.5 | 112.00 | 135.40 | 39.9 % | 71.0 % | 10 |
| 420 s | 107 | 1.5 | 94.89 | 111.69 | 33.8 % | 71.0 % | 11 |
| 480 s | 107 | 1.5 | 77.58 | 88.24 | 27.7 % | 71.0 % | 11 |
| 530 s | 107 | 1.5 | 58.77 | 64.26 | 21.0 % | 71.0 % | 13 |

Son los 107 ciclos con déficit para los que tenemos a la vez el `status-statement` (déficit y `opensAt`) y el feed de mercado: del 26-10 al 27-10 y del 02-11 al 05-11.

Observaciones:

1. **El precio cae de forma casi lineal con el span.** El mejor precio disponible baja unos 17 CR/kWh por minuto, de 68.5 % del `imbalancePrice` a los 60 s a 21 % a los 530 s. No hay un punto en que se estabilice.
2. **MET sigue su curva publicada.** Parte cerca de `0.9 × imbalancePrice` (253.97 con un `imbalancePrice` promedio de ~280) y baja unos 23.7 CR/kWh por minuto. En casi todos los ciclos es la única oferta (1.5 ofertas vivas en promedio), así que el libro es, en la práctica, MET.
3. **La disponibilidad casi no depende del span.** El libro alcanza a cubrir el déficit en 77 % de los ciclos a los 60 s y en 71 % desde los 180 s en adelante. Los ciclos sin ninguna oferta suben de 5 a 13 recién en los últimos minutos.
4. **El costo de esperar está en el margen, no en el precio.** Después de `lastBidAt` (540 s) el vendedor ya no acepta bids, y la cadena bid → `bid-accepted` → `swap-proposed` → aceptación tomó varios segundos en nuestros datos (p95 de la aceptación: 3.3 s; 7 de 21 swaps descartados por no calzar con el bid o estar vencidos). Un span de 530 s no deja margen para reintentar si el primer bid falla.

Límites del contrafactual: el precio no incluye transporte; el `remaining` es el que publicó el vendedor y puede ir atrasado respecto de lo que ya vendió a otros; y no modela el efecto de nuestro propio bid sobre el mercado. Mide el precio **disponible**, no el precio que habríamos pagado.

## 6. Qué medimos de la wallet por el camino

Las escrituras pasan por `wallet_ops`: la `Idempotency-Key` se persiste antes de enviar, se reintenta con la misma llave en 502/504 y se respeta `Retry-After` en 429.

| Operación | Operaciones | Intentos prom. | Con reintento | p50 hasta resolver | p95 hasta resolver |
| --- | ---: | ---: | ---: | ---: | ---: |
| accept (comprador) | 14 | 1.00 | 0 | 1.78 s | 3.29 s |
| propose (vendedor) | 25 | 1.04 | 1 | 1.79 s | 5.26 s |

- Todas las operaciones terminaron con HTTP 202. Hubo un solo error intermedio: un **503 en un `propose` del vendedor** el 27-10 a las 6:25:48 (hora mostrada por New Relic, 584 ms). Es el único reintento que registra `wallet_ops` (25 propuestas, 26 requests en New Relic): se reintentó con la misma `Idempotency-Key` y la wallet respondió 202. No vimos 429, 502 ni 504.
- Las 14 aceptaciones del comprador se resolvieron con `swap-rejected` / `INSUFFICIENT_ASSET`: la wallet respondió rápido y bien; el rechazo fue por nuestro saldo, no por la wallet.
- El vendedor liquidó 16 swaps (127 160 kWh por 17.7 M CR) entre el 26-10 19:46 y el 27-10 20:45 UTC, dentro del periodo de puntaje.
- Latencia por request según New Relic (llamadas a la wallet desde `master`, 26-10 al 27-10):

  | Operación | Requests | p50 | p95 |
  | --- | ---: | ---: | ---: |
  | `propose` (vendedor) | 26 | 546 ms | 714 ms |
  | `get` (saldo y estado de swaps) | 22 | 175 ms | 511 ms |
  | `accept` (comprador) | 14 | 164 ms | 195 ms |

- La latencia de la wallet es una fracción pequeña del tiempo hasta resolver la operación (p50 de 1.8 s en `wallet_ops`). El resto es esperar el evento de la wallet (`swap-settled` o `swap-rejected`) que cierra la operación, no la llamada HTTP. Para el span esto significa que el margen que hay que dejar antes de `lastBidAt` lo dominan el vendedor y los eventos, no la wallet.
- Después del 27-10 New Relic no registra llamadas a la wallet: es el periodo del incidente, en que el nodo no persistía eventos y por lo tanto no operaba en el mercado.

## 7. Qué concluimos

- **Sobre el span, con nuestros datos de compra no podemos concluir nada**: hubo un solo valor mientras el comprador podía operar y cero compras liquidadas.
- **En este mercado, esperar paga.** El precio disponible cae unos 6 puntos porcentuales del `imbalancePrice` por minuto y la disponibilidad casi no cambia después de los 3 minutos. Nuestro span de 420 s tenía el mejor precio a un 34 % del `imbalancePrice`; 480 s lo habría bajado a 28 %. Con los datos que tenemos elegiríamos **480 s**: es el más tardío que todavía deja un minuto antes de `lastBidAt` para reintentar con otra oferta.
- Esta conclusión vale para un mercado dominado por MET, que baja su precio por reloj. Si más ciudades vendieran, o si otros compradores esperaran lo mismo que nosotros, el `remaining` se agotaría antes y el óptimo se movería hacia spans más cortos.
- **El factor dominante del resultado no fue el span sino el crédito.** Una vez fuera de la línea de crédito, ningún span compra. La lección para el comprador es protegerse de esa caída: comprar desde el primer ciclo, aunque sea a un precio alto, cuesta mucho menos que pagar el déficit a 3× y quedar bloqueado.

## 8. Lo que no podemos concluir

1. **El mercado cambia porque los demás también experimentan.** Los otros grupos ajustaron precios y spans en el mismo periodo; el contrafactual de un día no vale para otro.
2. **Un solo valor de span en el periodo útil.** Sin variación no hay comparación; la rotación del 05-11 no genera bids por el bloqueo de crédito.
3. **El contrafactual no es una compra.** No sabemos si el vendedor nos habría aceptado, ni cuánto transporte habríamos pagado, ni si otro comprador llegaba antes.
4. **Datos incompletos.** El feed de mercado sí se guardó todos los días (se persiste por un camino distinto al del incidente), pero del 27-10 al 02-11 no tenemos el `status-statement`: sin déficit ni `opensAt`, esos ciclos no entran al contrafactual.
5. **Pocos ciclos con bids.** Los 21 bids reales cubren 17 ciclos de un solo día: ninguna diferencia entre ellos es estadísticamente distinguible.
6. **El `remaining` del feed puede ir atrasado.** Si otro comprador compró a MET y MET no publicó `offer-updated` antes del span, el contrafactual sobreestima lo disponible. La columna de cobertura es un techo, no una medida exacta.

## 9. Cómo reproducir

```bash
cd ~/energyshark && sudo docker compose -f docker-compose.prod.yml exec -T db psql -U energyshark -d energyshark < informe-span-consultas.sql
```

Las consultas son de solo lectura (crean vistas temporales). El corte del periodo de puntaje está en la variable `corte` al inicio del archivo.
