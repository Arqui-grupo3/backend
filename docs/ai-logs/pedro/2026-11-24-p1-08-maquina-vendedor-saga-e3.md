# AI Log P1-08 · Máquina del vendedor en Step Functions y Lambdas (E3 · Tarea 1.1)

- **Fecha:** 2026-11-24
- **Integrante:** Pedro González (P1)
- **Rama:** `feat/p1-seller-saga-machine`
- **Requisitos cubiertos:** AD7 (tarea 1.1 del Roadmap E3), RNF02 (parte serverless del vendedor en CDK)

## 1. Objetivo de la sesión
Construir y dejar desplegable con AWS CDK (`EnergyShark-Saga`) la máquina de estados **Step Functions Standard** del vendedor con los 8 estados definidos en el **ADR 0007** (`Reservar`, `Proponer`, `Avisar`, `EsperarCierre`, `Reconciliar`, `Cancelar`, `Compensar`, `Liquidado`), sus funciones Lambda con `Retry`/`Catch` frente a la wallet, y el endpoint interno HMAC en `master` (`POST /internal/sagas/:idpk/resultado`), dejando explícitamente la tabla DynamoDB de task tokens (`1.2`) para la siguiente iteración mediante un puerto inyectable (`TaskTokenStore`).

## 2. Decisiones clave tomadas durante la implementación
1. **Alineación previa y especificación OpenSpec (`p1-e3-seller-saga-machine`):** Se delimitó estrictamente el alcance a `1.1` sin alterar el flujo productivo de la E2.
2. **Permisos mínimos y prevención de dependencias circulares en CDK:**
   - Se usaron `grantRead` independientes por Lambda (`walletApiKey` solo en `Proponer`/`Reconciliar`/`Cancelar`; `brokerUrl` solo en `Avisar`; `internalHmacSecret` solo en `Resultado`).
   - Al ejecutar `cdk synth`, el validador detectó una dependencia circular (`F3004`) al referenciar `this.sellerStateMachine.stateMachineArn` desde las políticas de `Proponer` y `EsperarCierre`. Se corrigió usando el ARN determinista (`formatArn` con `stateMachineName: 'EnergyShark-SellerSwapSaga'`).
   - Se actualizó el runtime a `NODEJS_22_X` para evitar alertas de deprecación de `nodejs20.x`.
3. **Resolución de `States.ALL` y timeouts dinámicos:**
   - Se separaron los `Catch` de `States.Timeout` y `States.ALL` en `Proponer` y `EsperarCierre`.
   - `Reservar` calcula `waitCloseSeconds` (`expiresAt + 15s`, acotado por `closesAt + 30s`) para alimentar `TimeoutSecondsPath` de `EsperarCierre`, manteniendo el tope global de `25 minutos`.
4. **Frontera limpia con la tarea `1.2`:**
   - `Proponer` y `EsperarCierre` ejecutan `tokenStore.saveBeforeCall(...)` estrictamente antes de invocar la wallet (adaptador `noopTaskTokenStore` en `1.1`, listo para inyectar DynamoDB en `1.2`).

## 3. Archivos creados / modificados
- `infra/lambdas/seller/{shared,reservar,proponer,esperar-cierre,avisar,reconciliar,cancelar,resultado}.ts`
- `infra/lib/saga-stack.ts`, `infra/bin/infra.ts`, `infra/package.json`
- `infra/test/seller-lambdas.test.ts`, `infra/test/saga-stack.test.ts`
- `master/migrations/015-saga-runs.sql`, `master/sagas/index.js`, `master/index.js`, `master/test/sagas-internal.test.js`, `docker-compose.prod.yml`

## 4. Verificación
- `cd infra && npm test && npx cdk synth EnergyShark-Saga`
- `cd master && npm test`
