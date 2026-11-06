# Post-mortem: el comprador descartaba todas las ofertas por un error de escala en el transporte

| | |
| --- | --- |
| Periodo afectado | Domingo 25 de octubre, 13:25 → lunes 26 de octubre, ~18:45 (hora de Santiago) |
| Componente | Comprador (`master/market/selection.js`, usado por `master/buyer/worker.js`) |
| Severidad | Alta: ningún déficit se compró en el mercado durante el periodo de puntaje inicial |
| Estado | Corregido (PR #35). La consecuencia económica sigue: quedamos fuera de la línea de crédito |
| Decisiones relacionadas | ADR 0004 (serialización de la aceptación), ADR 0005 (consistencia ledger–wallet), ADR 0006 (estrategia como configuración) |

## Resumen

El comprador calculaba el transporte por kWh como `distance × transportCost`. La central publica `distance` en **metros** y `transportCost` en **créditos por kWh·km**, así que la fórmula correcta es `distance / 1000 × transportCost` (el enunciado la escribe `round2(distance_km × transportCost)`). El transporte salía 1 000 veces más caro: para MET, 6 588 CR/kWh en vez de 6,59. Con eso, el precio efectivo de toda oferta superaba `imbalancePrice` y el comprador la descartaba, sin escribir nada en el log. Durante unas 29 horas todos nuestros déficits se pagaron a 3×, y la deuda que eso generó nos dejó fuera de la línea de crédito por el resto del periodo.

## Línea de tiempo (hora de Santiago)

| Cuándo | Qué pasó |
| --- | --- |
| Dom 25, 13:00 | Abre el mercado de producción. La central lleva el saldo de cada cuenta a 1 232 073,36 CR |
| Dom 25, ~13:20 | Se despliega el comprador (PR #31 y #32) |
| Dom 25, 13:25 | Ciclo 249142, déficit de 17 901 kWh. El comprador arma su plan, pero `market_offers` del ciclo está vacío y no compra. Se pagan 5,17 M CR de desbalance |
| Dom 25 – lun 26 | Diagnóstico equivocado: concluimos que las ofertas de otras ciudades no llegaban a `market.REE`, porque nuestras consultas miraban ventanas de tiempo en que MET no tenía oferta. Alcanzamos a redactar una consulta al equipo docente sobre el binding de la cola |
| Lun 26, ~17:30 | Una consulta sobre todo el historial muestra 15 ofertas y 120 `offer-updated` de MET desde la apertura, y cero descartes en el connector. MET publicó en casi todos los ciclos |
| Lun 26, ~17:40 | Cruzando déficits con ofertas: en 7 ciclos con déficit hubo oferta de MET muy por debajo del castigo (por ejemplo, ciclo 249222: déficit 26 218 kWh, castigo 288,72, MET a 49,52) y el comprador mandó 0 bids |
| Lun 26, ~17:50 | Reproducción en la EC2: `rankOffers` con la oferta real de MET y la última `distance-table` devuelve una lista vacía. La ruta existe (`enabled: true, distance: 65880302, transportCost: 0.0001`) |
| Lun 26, ~18:00 | Confirmación con un dato de la central: el `trade-recorded` de nuestra venta a MET (ciclo 249226) trae `transportPerEnergy: 6.59` y `transportTotal: 70447.1` por 10 690 kWh. 65 880 302 / 1000 × 0,0001 = 6,59 |
| Lun 26, ~18:45 | Se despliega la corrección (PR #35) |
| Lun 26, 18:52 | Ciclo 249230: el comprador manda su primer bid real (823 kWh a MET a 90,86), recibe `bid-accepted`, verifica el token y acepta. La wallet rechaza con `INSUFFICIENT_ASSET`: el saldo ya estaba en −6,83 M CR, fuera de la línea de crédito |

## Impacto

- **Compras perdidas.** Ningún déficit entre el domingo 13:25 y el lunes ~18:45 se compró en el mercado. Solo en seis ciclos del lunes con oferta de MET disponible, el ahorro perdido estimado es de unos **9,2 M CR** (techo optimista: precio de cierre de MET más 6,59 de transporte, limitado a lo que le quedaba disponible). El ciclo 249222 por sí solo explica unos 4,5 M.
- **Score.** Esos ciclos cuentan como no participar (ahorro 0), pero su baseline sí entra al denominador y diluye el ahorro de las ventas.
- **Saldo y línea de crédito.** El saldo pasó de +1,23 M CR (domingo 13:00) a −7,0 M CR (lunes 19:11). Con la línea de crédito en 2 × el financiamiento del ciclo, quedamos fuera de ella antes de que la corrección llegara a producción. Desde ahí la wallet rechaza toda compra, cada ciclo con déficit se paga a 3× (−2,35 M CR netos en promedio) y el saldo siguió cayendo: −19,5 M CR el martes 27 a las 16:40, unos −12 M CR al día. El enunciado no trae un mecanismo para volver a la línea en ese escenario; el ayudante lo confirmó y lo escaló al equipo docente.
- **Lo que no se afectó.** Los reportes (todos `acknowledged`, sin multas desde la apertura), el vendedor (proponer un swap retiene kWh, no CR) y el gate G04 (primer swap liquidado el lunes 26, ciclo 249224).

## Causa raíz

1. **Unidades.** `selection.js` multiplicaba `route.distance × rate` sin convertir metros a km. La `distance-table` real trae distancias del orden de 10⁷ (metros) y costos del orden de 10⁻⁴ a 10⁻² por kWh·km.
2. **Las pruebas validaban el error.** Las pruebas del comprador usaban una tabla inventada (`distance: 100, transportCost: 1`) que daba valores razonables con la fórmula equivocada. No había ninguna prueba con un mensaje real de la central, y el formato de la tabla nunca se comparó con la página de distancias del enunciado, que muestra km, metros y "créditos / (kWh·km)".
3. **El descarte era silencioso.** Cuando el ranking queda vacío, el worker devuelve "nada que hacer" sin log ni métrica. Un comprador con plan, con ofertas en el feed y sin bids no dejaba rastro.

## Por qué tardamos en detectarlo

- **Concluimos con datos parciales.** Las primeras consultas sobre `market_feed` cubrían 30 minutos o un ciclo puntual, y en esos momentos MET no tenía oferta. Concluimos que la cola no recibía ofertas de otras ciudades y buscamos el problema en el broker, no en nuestro código.
- **No cruzamos los dos lados.** Recién al poner en una misma consulta los ciclos con déficit, las ofertas de ese ciclo y los bids del comprador apareció el patrón: había oferta, había plan y no había bid.
- **No había alertas sobre el comportamiento del comprador**, solo sobre la caída de `master` o del connector.

## Qué funcionó

- Reproducir el problema en producción con los datos reales (oferta y `distance-table`) en vez de razonar sobre el código.
- Confirmar la escala con un dato autoritativo de la central (`transportPerEnergy` del `trade-recorded`) antes de cambiar la fórmula.
- La corrección fue chica y quedó cubierta por una prueba con los valores reales: MET → REE da 6,59 de transporte y 56,11 de precio efectivo, y KLD queda en 10 + 738,38, por sobre el castigo.
- El resto del comprador funcionó a la primera en producción: selección, bid, verificación del token, accept y manejo del rechazo de la wallet.

## Qué no funcionó

- Las pruebas usaban unidades inventadas y nunca se contrastaron con un mensaje real.
- El PR #35 dejó por error dos archivos de prueba en `master/market/` en vez de `master/test/`. `npm test` no los ejecuta, y en `main` quedaron 8 pruebas fallando hasta que se movieron (rama `fix/buyer-presupuesto`). El archivo duplicado se eliminó en `fix/config-unificada`.
- El diagnóstico equivocado casi termina en una consulta al equipo docente por un problema que era nuestro.

## Acciones

| Acción | Estado |
| --- | --- |
| Corregir la escala del transporte y agregar una prueba con la `distance-table` y el `trade-recorded` reales | Hecho (PR #35) |
| Limitar la compra al margen de crédito (`available + creditLine`), para no pedir lo que la wallet va a rechazar | Hecho (PR #37) |
| Volver a pedir el remanente después de un `QUANTITY_UNAVAILABLE` | Hecho (PR #41 y #42) |
| Una sola configuración para comprador y vendedor, con el interruptor de emergencia compartido | Hecho (`fix/config-unificada`) |
| Registrar en el log cuántas ofertas descarta el comprador y por qué (sin ruta, precio efectivo sobre el castigo, bajo `minBid`) | Pendiente |
| Alerta en New Relic para un ciclo con déficit que llega a `lastBidAt` sin bids habiendo ofertas en el feed | Pendiente |
| Contract tests con mensajes reales de la central (`distance-table`, `status-statement`, `trade-recorded`) en CI (RDOC04) | Pendiente |
| Mecanismo para volver a la línea de crédito | Escalado al equipo docente |

## Lecciones

1. **Toda prueba que dependa de un mensaje externo debe tener al menos un caso con un mensaje real.** Si las unidades son inventadas, la prueba confirma lo que el código ya hace, no lo que la central manda.
2. **Un "no hago nada" del comprador también es un evento.** Si el comprador decide no comprar habiendo ofertas, tiene que quedar en el log con el motivo.
3. **Antes de culpar a la infraestructura, mirar el historial completo** y cruzar lo que entra con lo que hace el nodo.
4. **Un error de compra no cuesta solo el ciclo.** Con la línea de crédito atada al financiamiento y el desbalance a 3×, unas horas comprando mal nos dejaron sin comprador por el resto del periodo. Los errores del comprador tienen que detectarse en minutos, no en un día.
