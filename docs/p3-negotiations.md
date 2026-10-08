# P3: Negociaciones Voluntarias, Timeouts y Liquidación Contable

## Resumen del Flujo

Las negociaciones voluntarias permiten a la ciudad intercambiar bolsas de energía con la central de forma planificada durante la ventana de negociación del ciclo.

El flujo se divide en tres fases:
1. **Propuesta (`negotiation-proposal`)**: La ciudad emite su oferta con un tope de precio (`pricePerEnergy`).
2. **Confirmación (`give` o `take`)**: La central responde dentro de 30 segundos confirmando la operación.
3. **Pago (`transfer`)**: La parte que paga emite una transferencia por el total acordado (`energy * pricePerEnergy`).

---

## 1. Reglas y Precios de Negociación

- **Compra de Energía (`take`)**:
  - La ciudad recibe energía y paga por ella.
  - Se liquida al costo de generación de la ciudad para ese ciclo (`generationCost`).
  - Al recibir la confirmación `take`, la ciudad descuenta fondos de su presupuesto y emite `transfer` a la central con `becauseOf: msgId_take`.
  - Efecto contable en el ledger:
    - `energyBalance += energy`
    - `budgetBalance -= energy * pricePerEnergy`

- **Venta de Energía (`give`)**:
  - La ciudad entrega energía y recibe fondos.
  - Se liquida con un premium del 5%: `round2(1.05 * generationCost)`.
  - Máximo vendible en un ciclo: `max(0, generationCapacity - consumption)`.
  - Al recibir la confirmación `give`, la ciudad espera la transferencia de la central dentro de los 30 segundos posteriores.
  - Efecto contable en el ledger (al recibir el pago):
    - `energyBalance -= energy`
    - `budgetBalance += energy * pricePerEnergy`

---

## 2. Manejo de Timeouts y Reintentos (ADR 0003)

El protocolo exige dos plazos de **30 segundos**:
1. Desde que enviamos la propuesta hasta recibir la confirmación de la central.
2. Desde la confirmación hasta el pago:
   - En `take`: La ciudad emite el pago inmediatamente.
   - En `give`: La ciudad espera el pago de la central durante 30 segundos.

### Reglas críticas de reintento:
- Si se vence el plazo sin recibir confirmación (o sin recibir el pago de la central en `give`), se asume que no hubo operación real.
- El reintento se realiza **con el mismo `idpk`** (garantía de idempotencia para no duplicar operaciones).
- Cada intento lleva un **`msgId` nuevo y aleatorio** (referenciando el anterior según corresponda).
- Límite máximo: **1 intento inicial + hasta 3 reintentos** (total máximo de 4 intentos). Si se agota, el trabajo pasa a `status: 'expired'`.

---

## 3. Manejo de Errores de la Central

- `PRICE_ABOVE_CAP` (HTTP 422):
  - El precio ofertado supera el tope (`round2(1.05 * generationCost)`).
  - La central devuelve el tope permitido en `data.cap`.
  - El trabajo se marca como `failed` con `last_error: 'PRICE_ABOVE_CAP'` y se persiste el `cap`.
- `OVER_CAPACITY` (HTTP 409):
  - La propuesta `give` excede la capacidad vendible restante del ciclo.
  - La central devuelve la energía vendible disponible en `data.spare`.
  - El trabajo se marca como `failed` con `last_error: 'OVER_CAPACITY'` y se persiste el `spare`.
- `CYCLE_EXPIRED` (HTTP 410):
  - La ventana de negociación del ciclo ya cerró. El trabajo se marca como `expired`.

---

## 4. Persistencia y Recuperación ante Caídas

Toda la máquina de estados se almacena en PostgreSQL:
- `negotiation_jobs`: Registra cada propuesta (`idpk` único), ciclo, dirección, cantidades, estado actual (`pending`, `confirmed`, `paid`, `expired`, `failed`), fase y plazo de vencimiento (`due_at`).
- `negotiation_attempts`: Historial completo de cada intento de mensaje publicado y correlación de respuestas (`ack`, confirmaciones, errores).
- Al reiniciar el proceso, el worker lee los trabajos pendientes o confirmados desde la base de datos y retoma la cuenta de vencimiento exactamente en la fecha guardada (`due_at`), garantizando que la caída de un contenedor no pierda ni duplique operaciones.

---

## 5. Integración con el `negotiation-report`

El worker de reportes verifica que no existan negociaciones incompletas o en curso (`status IN ('pending', 'confirmed')`) antes de generar el snapshot del ciclo.
Una vez que las operaciones voluntarias están liquidadas (`paid`, `failed` o `expired`), el reporte toma los saldos exactos de `cycle_state` y publica el informe a la central sin bloqueos.
