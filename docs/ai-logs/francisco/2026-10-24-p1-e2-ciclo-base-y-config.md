# AI log — P1 — Ciclo base contra la central y configuración en caliente

- Integrante: P1 (Francisco), equipo EnergyShark, ciudad REE.
- Herramienta: Claude (aplicación de Claude).
- Accesos del asistente: repositorio `Arqui-grupo3/backend` en GitHub con permiso de solo lectura; copia local del backend conectada a la conversación; un Postgres de prueba propio para correr las pruebas. Sin acceso a la EC2: los comandos los corrió el usuario y pegó las salidas.
- Periodo: 24 de octubre de 2026; zona America/Santiago.
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

Continúa el registro [Entrega 2](2026-10-21-24-p1-e2.md). Se omitieron los mensajes de mera continuación. Las salidas de terminal pegadas se resumen en el contexto de cada sección. Los prompts se citan tal como se escribieron.

---

## 1. Ciclo base contra la central real

### Prompts relevantes

> ☐ P3: ciclo base contra la central real: status-statement, eventos de la wallet, imbalance-settlement y negotiation-report en todos los ciclos
> quiero que me expliques paso a paso como hacer esto y me explique el como funciona

> quiero hacer el paso que te dije antes

> [pega la salida de `docker compose ps` y de los logs de `master` en la EC2] hasta que hora tendria que esperar?

> [adjunta una captura del roadmap con las tareas pendientes] esto le falta a mi grupo, es por cosas que le falta?

### Contexto aportado

El usuario corrió en la EC2 los comandos que se le propusieron y pegó las salidas: estado de los contenedores, variables de `master`, la consulta por ciclo y el saldo local de `wallet_effects`.

### Trabajo asistido

- Explicación del ciclo de 20 minutos sin trades: qué llega en cada instante (`status-statement`, eventos de la wallet, `imbalance-settlement`), qué hace el nodo, dónde queda cada cosa en la base y por qué el reporte es lo crítico (50.000 CR por ciclo sin reporte).
- Revisión de `main` en GitHub para confirmar qué ya estaba desplegado: el arreglo de reportes, los arreglos del vendedor y la línea `COPY seller/`.
- Una consulta SQL que muestra, por ciclo, el `status-statement`, el `transfer`, el `imbalance-settlement`, el estado del reporte y la cantidad de efectos. También una tabla de síntomas y causas probables.
- Lectura del resultado:
  - Los ciclos 249091 a 249093 quedaron completos, con el reporte `acknowledged`.
  - Los ciclos `blocked` eran de la imagen anterior al arreglo de reportes, y el `expired` coincidía con la caída de `master`.
  - Los logs de New Relic no eran errores del nodo.
- Hallazgo pendiente: el saldo local muestra 117.168 kWh acumulados y −41 millones de CR. El CR negativo se explica, al menos en parte, por la falta del comprador, porque cada déficit se paga a `imbalancePrice`. La acumulación de kWh no se explica por eso. Queda por comparar con `GET /balance`.
- Priorización de lo pendiente para el domingo: comprador, libro de ofertas, swap con MET, configuración en caliente y alertas.

### Decisiones del usuario

Corrió él mismo cada comando en la EC2, sin dar al asistente acceso al servidor ni a las credenciales. Pidió saber qué le faltaba al grupo antes de seguir con la siguiente tarea.

---

## 2. Incidente de deploy por `seller/`

### Prompts relevantes

> [adjunta una captura del job "Desplegar en la EC2" fallido: la API responde 502 en los 20 intentos] esto con los datos anteriores

### Trabajo asistido

- Diagnóstico desde `main` en GitHub: el PR #24 agregó `require('./seller')` en `master/index.js`, pero el `master/Dockerfile` no copiaba `seller/`. `master` se caía al partir y el API Gateway respondía 502. Es el mismo patrón del incidente de `./wallet` (PR #22).
- Arreglo de una línea (`COPY seller/ ./seller/`), con una prueba local de la imagen antes de subirla.

### Decisiones del usuario

Aplicó el arreglo, abrió el PR #27 hacia `main` y llevó el cambio a `develop` con el PR #28.

---

## 3. Configuración en caliente mínima

### Prompts relevantes

> configuración en caliente mínima (endpoint, sin interfaz): precio, cantidad, span y flag para apagar el mercado
> quiero que me ayudes y me expliques paso a paso como hacer esto

> no quiero que hagas un .patch, quiero que cambies directamente los archivos

### Trabajo asistido

- Diseño según el ADR 0006:
  - Cada cambio crea una versión nueva en `strategy_config`.
  - Precio (`priceFactor`), cantidad (`maxQuantity`) y span (`spanSeconds`) se congelan por ciclo al llegar el `status-statement`, en `cycle_config`.
  - El interruptor `marketEnabled` se lee en vivo y, al apagarlo, retira altiro las ofertas activas.
- Cambios en `master`:
  - Archivos nuevos: la migración `010-strategy-config.sql` y el módulo `config/`.
  - En el vendedor: `publishSellerOffer` usa el factor y el tope, y hay una función nueva, `withdrawActiveOffers`.
  - Endpoints `GET /config`, `PUT /config`, `GET /config/history` y `GET /config/cycles/:cycleId`, todos con autenticación.
  - `COPY config/ ./config/` en el Dockerfile, por la lección del incidente anterior.
- El piso de 1,05 × costo propio se mantiene para cualquier factor, así que la configuración no permite vender con pérdida.
- 7 pruebas nuevas: validación, versiones, cambios simultáneos, congelamiento por ciclo, oferta con factor y tope, y retiro con rechazo de bids. Pasan las 96 pruebas de `master`, y los endpoints se probaron con un `master` local.

### Decisiones del usuario

El asistente entregó primero un parche. El usuario pidió en cambio que se modificaran directamente los archivos de su carpeta, y así se hizo. Antes de escribir, el asistente comparó esa carpeta con `main`: le faltaban la línea `COPY seller/` y un comentario propio del usuario, que se conservó. El commit y el push quedaron a cargo del usuario.

---

## Resultado y límites

- El ciclo base funciona contra la central desde el deploy del PR #28: tres ciclos seguidos con el reporte `acknowledged` al momento de este registro. Faltaba completar unas 2 horas de ciclos para tachar la tarea.
- El saldo local no cuadra con lo esperado en kWh. Queda pendiente compararlo con la wallet. Además, `master` busca `WALLET_BASE_URL` y `WALLET_API_KEY`, y no se encontraron en el `.env` de la EC2. Si faltan, el vendedor no publica ofertas.
- La configuración en caliente queda en la carpeta del usuario, pendiente de PR. Faltan las rutas en el API Gateway, si están definidas una por una. El span todavía no lo usa nadie, porque el comprador (P2) no existe.
