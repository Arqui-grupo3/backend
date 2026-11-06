# AI log — P1 — Robustez de AD5 y Conciliación con la Wallet

- Integrante: P1 (Pedro González), equipo EnergyShark, ciudad REE.
- Herramienta: Google Antigravity (Gemini 3.8 Flash).
- Periodo: 5 de noviembre de 2026; zona America/Santiago.
- Fuente: conversación «P1: robustez de AD5, swap-settled duplicado/desordenado, timeout en escrituras y conciliación de balance».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> https://docs.google.com/document/d/1xKJTe3rQXum07cXUbfI32OJFDSPmBigaZp7x6o2gSA0/edit?tab=t.0
> Podemos ir avanzando. Un compañero boto el ramo y nos repartimos su parte, recuerda que yo soy p1.
> P1: robustez de AD5: swap-settled duplicado o desordenado, escrituras con timeout que sí se procesaron, conciliación con GET /balance al cierre.
> Avanzemos con esto, cual es tu idea para resolver esta parte?? y explicame en que consiste

> Arreglemos eso del enlace de google docs, antes de avanzar con openspec-propose

> ya la conecte, vamos con /openspec-propose

> /openspec-apply-change

## Contexto aportado

Tras la baja de un integrante del equipo (P3), se redistribuyeron las responsabilidades para la Entrega 2, asignando a P1 las tareas nucleares de consistencia contable de la Decisión de Arquitectura 5 (AD5):
1. **Invarianza contable ante eventos desordenados o duplicados (Anomalía 1 / RF05)**: `swap-settled` duplicado o que llega fuera de secuencia respecto a `trade-recorded` o al cierre.
2. **Escrituras con timeout que sí se procesaron (Anomalía 4)**: Llamadas a `POST /swaps` que sufren timeout HTTP en el cliente pero fueron creadas efectivamente en la wallet central.
3. **Conciliación de balance al cierre (AD5)**: Medida formal de AD5 ("Al cierre de cada ciclo, el saldo del dashboard coincide con GET /balance o el delta queda explicado").

## Trabajo asistido

1. **Lectura del Roadmap y Análisis de Arquitectura**:
   - Inspección del documento de equipo `EnergyShark E2 · Roadmap y reparto` y de `docs/ADR/ADR-consistencia_ledger_wallet.md`.
   - Diagnóstico del estado del plugin de Google Docs y resolución de la consulta sin bloqueos.
2. **Propuesta formal OpenSpec (`p1-ad5-ledger-wallet-robustness`)**:
   - `proposal.md`: Alcance técnico de la conciliación y mitigación de anomalías de red.
   - `specs/ledger-wallet-reconciliation/spec.md`: Especificación con escenarios `WHEN`/`THEN` de conciliación con delta cero, absorción de asientos desde `/statement` e invarianza contable.
   - `specs/seller-bid-serialization/spec.md`: Actualización del requerimiento de propuesta de swaps para incorporar apareo reactivo de `swap-proposed`.
   - `design.md`: Modelo relacional de `cycle_reconciliations`, algoritmo de cuadratura en dos pasos y recuperación de timeouts.
   - `tasks.md`: Plan de 13 tareas estructuradas en 4 fases.
3. **Migración de Base de Datos (`master/migrations/009-reconciliation.sql`)**:
   - Creación de tabla `cycle_reconciliations` (`cycle_id`, `local_cr`, `wallet_cr`, `delta_cr`, `status`, `explanation`, `statement_entries`, `reconciled_at`).
   - Registro en el runner de migraciones de `master/ledger/index.js`.
4. **Módulo de Conciliación (`master/reconciliation/index.js`)**:
   - Función `reconcileCycle`: Compara `wallet_local_balance` frente a `GET /balance`. Si hay delta ($delta \neq 0$), invoca `GET /statement` para ese ciclo, inserta los asientos faltantes en `wallet_effects` (`source: 'statement'`, `kind: 'adjustment'`), recalcula el balance y documenta la explicación.
   - Función `getReconciliation`: Consulta el snapshot por ciclo.
   - Hook automático en `master/index.js` ante `imbalance-settlement` para ejecutar la conciliación al cierre (T+10:00).
   - Endpoint `GET /cycles/:cycleId/reconciliation` expuesto para consulta del dashboard.
5. **Robustez ante Timeouts en Seller (`master/seller/index.js` y `master/index.js`)**:
   - Implementación de `handleSwapProposed`: Vincula `swap_id` a `seller_bids` por `swap_idpk` y transiciona el bid a `proposed`.
   - Conexión del evento `swap-proposed` en el endpoint de eventos del master, permitiendo que bids que sufrieron timeout en `proposeSwap` no queden huérfanos y puedan ser liquidados por el posterior `swap-settled`.
6. **Pruebas Automatizadas**:
   - Creación de `master/test/reconciliation.test.js` con 4 tests (delta cero, absorción de `/statement`, delta no explicado y tolerancia a fallos de red).
   - Ampliación de `master/test/seller.test.js` con prueba de recuperación de timeout (Anomalía 4).
   - Ejecución combinada de 40 pruebas en el backend (`reconciliation.test.js`, `seller.test.js`, `effects.test.js`, `wallet.test.js`), todas 100% aprobadas.

## Revisión y decisiones del usuario

- Se priorizó resolver las partes asumidas de P3 con foco en no quebrar la arquitectura de microservicios existente.
- Se mantuvo el esquema append-only de `wallet_effects` para absorber asientos de `/statement` sin mutar asientos existentes.
- Se mantuvieron los cambios en la rama dedicada `feat/p1-ad5-ledger-wallet-robustness`.

## Resultado y límites

- AD5 queda plenamente satisfecho en el backend de REE.
- Las anomalías 1 y 4 de la demo cuentan con código y pruebas que respaldan su recuperación autónoma.
- El nodo está listo para validar la conciliación en vivo en el dashboard.
