# ADR 0005 — Consistencia entre el ledger local y la wallet (AD5)

## Contexto

En la E2 la wallet es la fuente de verdad de CR y KWH; nuestro ledger solo sirve para decidir y mostrar. Lo alimentan los eventos de la wallet que llegan por `city.REE`, y esos eventos pueden llegar duplicados, desordenados o sin que hayamos visto el 202 de la operación que los causó. Además, algunos movimientos solo aparecen en `GET /statement` (por ejemplo, el asiento `adjustment` que lleva el saldo a 3 financiamientos al abrir el mercado). El ledger de la E1 (ADR 0002) suponía un orden de aplicación y nunca se comparaba con una fuente externa.

| Parte | Valor |
| --- | --- |
| Fuente | La wallet |
| Estímulo | Un `swap-settled` duplicado, otro que llega después del `trade-recorded` del mismo swap, y uno de una operación cuyo 202 nunca recibimos |
| Ambiente | Operación normal |
| Artefacto | La aplicación de eventos de la wallet al ledger interno |
| Respuesta | Cada evento se aplica una sola vez, en cualquier orden, y el nodo detecta por sí mismo cuando su saldo interno se desvió del de la wallet |
| Medida | Al cierre de cada ciclo, el saldo del dashboard coincide con `GET /balance`, o explicamos el delta desde nuestros registros |

## Alternativas consideradas

### A. Mantener el ledger de la E1 y aplicar en orden de llegada

- **A favor:** no hay que cambiar nada; el `idpk` único ya descarta duplicados.
- **En contra:** el resultado depende del orden en que lleguen los eventos, y nunca nos enteramos de una desviación: el ledger se cree a sí mismo. No cumple la segunda mitad de la respuesta.

### B. Sin ledger local: leer siempre `GET /balance`

- **A favor:** el saldo mostrado siempre es el real.
- **En contra:** la wallet es lenta, falla y tiene límite de 300 lecturas por minuto. Perdemos la historia de cómo se llegó a cada saldo, que piden RF01 y la propia medida ("explicar el delta"). Tampoco sirve para decidir rápido durante el mercado.

### C. Event log con efectos idempotentes por clave natural, más conciliación por ciclo

- **A favor:** cada efecto se aplica una vez sin importar el orden ni cuántas veces llegue. La conciliación detecta desvíos y deja registrado su origen. Conserva el event log de la E1, que funcionó.
- **En contra:** hay que definir una clave por tipo de efecto y mantener un worker de conciliación más.

## Decisión

**C.** Es la única que cumple las dos mitades de la respuesta: aplicar una vez en cualquier orden, y detectar el desvío por sí mismo.

Mecanismo:

1. **Toda escritura a la wallet se persiste con su `idpk` antes de enviarse** (tabla `wallet_ops`). Así, un evento cuyo 202 nunca llegó se aparea igual por `data.idpk`.
2. **Cada efecto sobre el saldo tiene una clave natural única**, no depende del evento que lo trae:
   - liquidación de un swap → `swapId`;
   - transporte → `swapId` del `trade-recorded`;
   - financiamiento, multa y desbalance → `cycleId` y tipo.
   
   Un `swap-settled` duplicado o tardío choca con la clave y no tiene efecto; queda registrado como duplicado (RF05).
3. **Los efectos son sumas con signo**, así que el saldo no depende del orden en que se aplican.
4. **Conciliación al cierre de cada ciclo** (tras el `imbalance-settlement`): se compara el saldo local de CR con `GET /balance`. Si hay delta, se trae `GET /statement` y se identifican los asientos que no están en nuestro log.
5. **El delta se registra, no se borra.** Cada asiento faltante entra al log como evento `reconciliation` con su referencia al `/statement`. Lo que no se pueda atribuir queda como delta sin explicar y dispara una alerta en New Relic.
6. **Cada conciliación se guarda como snapshot del ciclo** (tabla `cycle_reconciliations`: saldo local, saldo de la wallet, delta y su explicación). Es la proyección materializada que descartamos por plazo en el ADR 0002 y que el post-mortem de AD2 pide recuperar; aquí además sirve de evidencia para la medida y de lectura rápida para RF01.
7. **Cada conciliación se guarda como snapshot del ciclo** (`cycle_reconciliations`: saldo local, saldo de la wallet, corte, delta y explicación). Es la proyección por ciclo que descartamos en el ADR 0002; aquí sirve de evidencia para la medida y de lectura rápida para RF01.
8. **Cierre energético:** aunque los KWH terminan en 0, se compara la cobertura del `imbalance-settlement` con la que esperábamos según nuestros swaps liquidados. Una diferencia indica un swap mal contado.

## Consecuencias

- El dashboard muestra por ciclo el saldo local, el de la wallet y el delta con su explicación: esa es la evidencia de la medida.
- Los asientos que solo existen en `/statement` (como el `adjustment` de apertura) entran por conciliación, no por eventos.
- Los KWH no se concilian: la central los quema al cierre y toda cuenta queda en 0.
- La conciliación usa unas pocas lecturas por ciclo, muy por debajo del límite de la wallet.
- Pruebas: el mismo `swap-settled` dos veces, `trade-recorded` antes que `swap-settled`, un evento con un `idpk` cuyo 202 se perdió, y un delta inyectado que la conciliación debe detectar.
