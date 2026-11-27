# AI Log P1-10 · Reanudación de sagas en master y permisos mínimos EC2 (E3 · Tarea 2.1)

- **Fecha:** 2026-11-27
- **Integrante:** Pedro González (P1)
- **Rama:** `feat/p1-master-saga-resume`
- **Requisitos cubiertos:** AD7 (tarea 2.1 del Roadmap E3), RNF02 (permisos mínimos IAM para EC2 en CDK)

## 1. Objetivo de la sesión
Conectar el consumidor de `master` (`POST /events`) para reanudar ejecuciones de Step Functions (`SendTaskSuccess` / `SendTaskFailure`) al aplicar cada evento de la wallet, manteniendo simetría atómica con `DynamoTaskTokenStore` (`1.2`) y declarando la `ManagedPolicy` de permisos mínimos para la EC2 en `SagaStack`.

## 2. Decisiones clave
1. **Protocolo simétrico en DynamoDB:** `master/sagas/resume.js` ejecuta `UpdateItemCommand` condicional (`attribute_not_exists(pk) OR #status = :waiting`, `ReturnValues: 'ALL_OLD'`). Si había `taskToken` en `waiting`, llama a Step Functions (tolerando `TaskTimedOut` / `InvalidToken`); si el evento llegó antes que la Lambda, crea el ítem en `resolved` con `resultJson` y TTL 24 h para que `1.2` se resuelva sola; si ya estaba `resolved`, actúa como no-op idempotente.
2. **Aislamiento del flujo productivo:** Cuando `TASK_TOKENS_TABLE_NAME` no está definida opera como no-op, y en `POST /events` se ejecuta capturando errores de AWS para nunca reencolar mensajes en RabbitMQ.
3. **Permisos mínimos EC2:** Se creó `EnergyShark-Ec2SagaConsumerPolicy` en `SagaStack` (exportada como `EnergyShark-Ec2SagaConsumerPolicyArn`) limitada a `dynamodb:UpdateItem`/`GetItem` sobre `energyshark-saga-task-tokens` y `states:SendTaskSuccess`/`SendTaskFailure` sobre `EnergyShark-SellerSwapSaga` y `EnergyShark-BuyerSwapSaga`.
   - Para adjuntar al rol IAM de la EC2 tras el `cdk deploy`: `aws iam attach-role-policy --role-name <EC2_ROLE> --policy-arn <EnergyShark-Ec2SagaConsumerPolicyArn>`.

## 3. Archivos creados / modificados
- `master/sagas/resume.js`, `master/sagas/index.js`, `master/index.js`, `master/package.json`, `master/package-lock.json`, `master/test/saga-resume.test.js`
- `infra/lib/saga-stack.ts`, `infra/test/saga-stack.test.ts`, `docker-compose.prod.yml`

## 4. Verificación
- `cd master && TEST_DATABASE_URL=... npm test`
- `cd infra && npx tsc --noEmit && npm test && npx cdk synth EnergyShark-Saga --quiet`
