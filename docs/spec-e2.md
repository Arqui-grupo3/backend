# Spec · Entrega 2 · EnergyShark (protocolo v3)

---

## 1. Objetivo

Migrar nuestro nodo del protocolo de la E1 al protocolo v3 y operar de forma autónoma en el mercado entre ciudades, como vendedor y como comprador, durante todo el periodo de puntaje.

Metas, en orden de prioridad:

1. Cumplir todos los gates (G01–G09). Sin ellos la nota máxima es 4.0.
2. Cubrir RF01–RF06, AD4–AD6 y mantener RNF01–RNF05 operativos.
3. Maximizar el `score` del leaderboard para optar al bonus (top 3).

## 2. Contexto

En la E1 la central compraba y vendía energía a las ciudades. En la E2 la central se retira de la negociación y queda a cargo de:

- emitir la energía de cada ciudad al abrir cada ciclo;
- publicar las rutas (`distance-table`) y cobrar transporte;
- custodiar créditos (CR) y energía (KWH) en una **wallet** REST;
- liquidar al cierre lo que cada ciudad dejó sin resolver, a precios castigados.

Las ciudades comercian entre sí mediante ofertas y bids, y liquidan cada trato con un **swap** en la wallet (entrega contra pago).

## 3. Alcance

### Dentro del alcance

- Consumo de las dos colas: `city.{CODE}` y `market.{CODE}`.
- Cliente de la wallet: propuesta, aceptación y cancelación de swaps; lectura de saldo, swaps y statement.
- Rol de vendedor: publicar, mantener y retirar la oferta; aceptar o rechazar bids; proponer swaps.
- Rol de comprador: construir el libro de ofertas; elegir ofertas por precio efectivo; enviar bids; verificar y aceptar swaps.
- Ledger local alimentado por los eventos de la wallet, con conciliación contra `GET /balance`.
- Estrategia configurable en caliente (precio, cantidad, política de aceptación, span, política de selección).
- Vistas del frontend para RF01, RF02, RF04, RF05 y RF06.
- Monitoreo del consumidor de mercado y de las llamadas a la wallet.
- Documentación: ADR AD4–AD6, post-mortems AD1–AD3, UML, contratos v3, informe de span, AI logs.

### Fuera del alcance

- Cualquier mensaje retirado en v3 (`negotiation-proposal`, `give`, `take`, `transfer` de pago, `demand-statement`): la central los responde con `TYPE_RETIRED`.
- Optimización del score antes de tener el ciclo básico estable.

## 4. Ciclo de 20 minutos

La central es la única autoridad de tiempo. Todos los instantes se leen del `status-statement`, nunca del reloj propio.

| Instante | Qué hace nuestro nodo |
| --- | --- |
| T+0:00 | Recibe `status-statement` y `transfer` de financiamiento. Calcula `sellable` y déficit. Abre el mercado del ciclo |
| T+0:00 – T+8:30 | Vendedor: publica y actualiza su oferta. Comprador: arma su compra según el span |
| T+8:30 (`lastOfferAt`) | Última oferta, actualización o retiro |
| T+9:00 (`lastBidAt`) | Último instante para aceptar bids como vendedor |
| T+10:00 (`closesAt`) | La wallet deja de aceptar swaps. Llega `market-closed` y luego `imbalance-settlement` |
| T+10:00 – T+15:00 | Envía `negotiation-report` (reglas de la E1). Concilia el ledger |
| T+15:00 (`validUntil`) | Cierra la ventana. El mercado del siguiente ciclo corre durante el consumo de este |

Valores del ciclo que usamos:

- `sellable = floor(max(0, generationCapacity − consumption))`
- `déficit = ceil(max(0, consumption − generationCapacity))`
- `buybackPrice = round2(1.05 × generationCost propio)`: piso natural de la oferta.
- `imbalancePrice = round2(3 × max(generationCost de todas las ciudades))`: techo natural de cualquier compra.



## 5. Criterios de aceptación

| Requisito | Se considera listo cuando |
| --- | --- |
| G03 | El nodo completa 72 ciclos seguidos (un día) sin intervención manual y sin multa por no reportar |
| G04 | Hay al menos un swap liquidado dentro del periodo de puntaje |
| RF01 | Para cualquier ciclo se ve cada elemento pedido y cuál fue la última operación aplicada |
| RF02 | El libro muestra precio, `remaining`, transporte, precio efectivo y rutas deshabilitadas marcadas |
| RF03 | El nodo vende y compra con MET y con otra ciudad, y sobrevive a errores de la wallet |
| RF04 | Un cambio de configuración desde el frontend aplica sin redeploy |
| RF05 | Un bid y un `swap-settled` duplicados aparecen en el registro y no cambian el ledger |
| RF06 | La vista muestra al menos tres valores de span con datos de varios ciclos cada uno |
| AD4 | Bids simultáneos por más del `remaining` nunca generan dos swaps contra la misma cantidad |
| AD5 | Al cierre de cada ciclo, el saldo del dashboard coincide con `GET /balance` o el delta queda explicado |
| AD6 | Cada ciclo queda atribuido a la configuración que usó |
