# AI log — P1 — Estado de la oferta y lock por offerId (OpenSpec)

- Integrante: P1 (Pedro González), equipo EnergyShark, ciudad REE.
- Herramienta: Google Antigravity (Gemini 3.8 Flash).
- Periodo: 23–24 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «P1: estado de la oferta y lock por offerId para aceptar bids de a uno (OpenSpec)».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> Tengo que trabajar en la E2 del proyecto de IIC2173. El enunciado esta aca: https://arquisispuc.notion.site/2026-2-iic2173-entrega-2. Y el ayudante jefe o coordinador nos mando el ROADMAP para terminar la entrega. Yo quede a cargo de P1. Podrias resumir lo que tengo que hacer y explicarme eli5 que me toca

> Quiero revisar el roadmap de arriba hacia abajo. Vamos con la Fase 0. ☐ Todos (hoy): ADR AD4 (P1), AD5 (P3) y AD6 (P2) commiteados en main antes de cualquier código de la E2. Esto podrias confirmar si esta echo porfavor. Y que es?? tambien con explicación de los conceptos, que es ADR???

> vale revisa si ☐ P1 (hoy): spec y plan de milestones en /docs (RDOC02) esta echo?? Y sino armame una propuesta para hacer. Creo que lo hizo mi compañero por mi

> VAIe esta bien, sigamos con lo siguiente nomas, ☐ P1: estado de la oferta y lock por offerId para aceptar bids de a uno. ESto dame una propuesta y explicame como comenzar con esto, explicación sencilla porfa

> /openspec-explore Vale quiero hacerlo con openspec porque en la corrección me dijeron que era buena practica

> Hilo A: Opción 1, Hilo B: Mmm lo que tu creas conveniente. Hilo C: lo que tu creas, lo que escribiste me parece coherente. Si en alguna parte se menciona sobre esto en el ramo entonces deja la decision del ramo.

> /openspec-apply-change

> /openspec-archive-change

## Contexto aportado

El usuario definió las prioridades de la Fase 0 del Roadmap para el rol P1 (Vendedor y mensajes entre ciudades):
- Cumplimiento de la decisión arquitectural ADR 0004 (AD4) para evitar sobreventa de energía ante bids concurrentes.
- Eliminación del riesgo de rechazo por `INSUFFICIENT_ASSET` en la wallet central.
- Adopción de la metodología OpenSpec (`spec-driven`) para documentar y estructurar el cambio de forma previa a la codificación.
- Registro estricto de anomalías y duplicados (RF05).

## Trabajo asistido

1. **Auditoría de inicio**: Verificación de historial de Git y sincronización de repositorios (`backend`, `frontend`, `contratos`), confirmando que ADR 0004 y los milestones base (RDOC02) ya estaban fusionados en `main`.
2. **Exploración arquitectural (`openspec-explore`)**:
   - Modelado de flujos con diagramas ASCII: cola `city.REE.q` → Connector → Master → Postgres lock → Wallet central.
   - Definición de la máquina de estados de un bid (`received` → `reserved` → `proposed` → `settled` / `rejected` / `released`).
   - Mapeo de casos de contención por milisegundos con dos compradores simultáneos.
3. **Propuesta formal OpenSpec (`p1-seller-offer-state-and-lock`)**:
   - `proposal.md`: Justificación del problema de concurrencia y alcance técnico.
   - `specs/seller-bid-serialization/spec.md`: Requerimientos normativos con escenarios `WHEN`/`THEN` para serialización transaccional, cálculo de remanente, idempotencia (RF05) y restitución por expiración.
   - `design.md`: Decisiones técnicas de aislamiento de tablas y desacoplamiento de la llamada HTTP a la wallet fuera del lock de base de datos.
   - `tasks.md`: Plan de implementación dividido en 4 fases ejecutables (13 tareas en total).
4. **Implementación de Base de Datos**:
   - Creación de migración `master/migrations/008-seller.sql` con tablas `seller_offers` y `seller_bids`, restricciones de integridad e índices de ciclo y estado.
   - Registro de `'008-seller.sql'` en el migrador automático de `master/ledger/index.js`.
5. **Implementación de Lógica de Venta (`master/seller/index.js`)**:
   - `createSellerOffer`: Registro de ofertas vendibles del ciclo.
   - `getSellerOffer`: Consulta atómica de inventario total y disponible en tiempo real.
   - `processIncomingBid`: Adquisición de candado exclusivo `pg_advisory_xact_lock(hashtext(offer_id))`, deduplicación por `idpk`, cálculo de `available`, branching a `reserved` o `rejected` (`QUANTITY_UNAVAILABLE`) y llamada externa a `walletClient.proposeSwap()`.
   - `handleSwapSettled` y `handleSwapReleased`: Actualización de estado ante liquidación o liberación por expiración (Anomalía 3).
6. **Integración en Servicio Master (`master/index.js`)**:
   - Ruteo de eventos `bid` recibidos en `app.post('/events')`.
   - Handlers automáticos para eventos de swap (`swap-settled`, `swap-expired`, `swap-rejected`).
   - Endpoints REST de auditoría y monitoreo: `POST /seller/offer` y `GET /seller/offer/:offerId`.
7. **Pruebas Automatizadas (`master/test/seller.test.js`)**:
   - Suite con el runner nativo `node:test` y fixtures sobre esquemas PostgreSQL aislados.
   - 5 pruebas ejecutadas y aprobadas exitosamente (100% pass) contra PostgreSQL 16 local (`energyshark_test`):
     - Creación de oferta y cálculo de disponibilidad.
     - Contención concurrente real con `Promise.all` (exactamente una reserva y un rechazo).
     - Idempotencia de bids duplicados sin sobre-descuento (RF05).
     - Restitución automática de stock ante `swap-expired`.
     - Validaciones de entrada.
8. **Cierre de Ciclo OpenSpec**:
   - Archivo del cambio con `openspec-archive-change` hacia `openspec/changes/archive/2026-10-24-p1-seller-offer-state-and-lock/`.
   - Sincronización de los 4 requerimientos formales a la especificación principal `openspec/specs/seller-bid-serialization/spec.md`.

## Revisión y decisiones del usuario

- **Aislamiento de inventario**: Se eligió la Opción 1 (tablas dedicadas `seller_offers` y `seller_bids`) en lugar de reutilizar `market_offers`, evitando colisiones con el feed público de otras ciudades.
- **Descuento preventivo**: Se acordó descontar el disponible inmediatamente al reservar para no admitir peticiones destinadas al rechazo.
- **Restitución por expiración**: Se adoptó la liberación inmediata al recibir `swap-expired` con TTL $\le$ 60 s para devolver la energía vendible al mercado antes de `closesAt`.
- **Estrategia de ramas**: Se instruyó trabajar sobre la rama descriptiva `feat/p1-seller-offer-state-and-lock` (sin prefijo `codex/`).

## Resultado y límites

- Todo el código funcional y las pruebas quedaron verificados en el entorno local.
- Se garantizó que el nodo nunca incurrirá en `INSUFFICIENT_ASSET` por colisión de pedidos concurrentes.
- Limitación actual: La publicación periódica de la oferta inicial hacia RabbitMQ ante cada nuevo `status-statement` corresponde a la siguiente etapa (Fase 1 · Vendedor simple).
