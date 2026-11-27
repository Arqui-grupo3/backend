# AI Log P1-09 · Tabla de task tokens en DynamoDB (E3 · Tarea 1.2)

- **Fecha:** 2026-11-26
- **Integrante:** Pedro González (P1)
- **Rama:** `feat/p1-task-tokens-table`
- **Requisitos cubiertos:** AD7 (tarea 1.2 del Roadmap E3), RNF02 (DynamoDB + permisos mínimos en CDK)

## 1. Objetivo de la sesión
Aprovisionar la tabla DynamoDB `energyshark-saga-task-tokens` en `SagaStack` e implementar `DynamoTaskTokenStore` para persistir cada `taskToken` antes de llamar a la wallet y resolver la condición de carrera cuando un evento del broker llega antes que la escritura de la Lambda (ADR 0007, punto 4).

## 2. Decisiones clave
1. **Clave primaria prefijada `pk` (`idpk:<uuid_lower>` / `swapId:<id>`):** Evita colisiones entre operaciones y swaps, permitiendo consultas puntuales `O(1)` sin GSI desde `master` en `2.1`.
2. **Escritura condicional atómica:** `PutItem` con `ConditionExpression: "attribute_not_exists(pk) OR #status = :waiting"` y `ReturnValuesOnConditionCheckFailure: "ALL_OLD"` (con fallback a `GetItem` con `ConsistentRead: true`). Así un reintento de Step Functions actualiza el token mientras siga `waiting`, y si el consumidor ya dejó `status = "resolved"`, la propia Lambda completa su espera con `SendTaskSuccess`.
3. **Permisos mínimos:** Solo `SellerProponerFn` y `SellerEsperarCierreFn` reciben `dynamodb:PutItem`, `dynamodb:GetItem` y `TASK_TOKENS_TABLE_NAME`.

## 3. Archivos creados / modificados
- `infra/lambdas/seller/token-store.ts`, `infra/lambdas/seller/proponer.ts`, `infra/lambdas/seller/esperar-cierre.ts`
- `infra/lib/saga-stack.ts`, `infra/package.json`, `infra/package-lock.json`
- `infra/test/token-store.test.ts`, `infra/test/saga-stack.test.ts`

## 4. Verificación
- `cd infra && npm test && npx cdk synth EnergyShark-Saga --quiet`
