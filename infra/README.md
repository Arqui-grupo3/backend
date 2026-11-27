# infra · EnergyShark (AWS CDK)

Infraestructura como código del backend (RNF02), en AWS CDK con TypeScript. Cuenta `088674918891`, región `us-east-2`.

| Stack | Contenido | Dueño |
| --- | --- | --- |
| `EnergyShark-Base` | Secretos de la wallet y del broker en Secrets Manager | P2 |

## Requisitos

- Node 20 o superior.
- AWS CLI v2 con credenciales de la cuenta del grupo (`aws sts get-caller-identity` debe mostrar `088674918891`).

## Uso

```bash
cd infra
npm ci
npm test
npx cdk synth
```

Primer despliegue en la cuenta (una sola vez por cuenta y región):

```bash
npx cdk bootstrap aws://088674918891/us-east-2
```

Desplegar:

```bash
npx cdk deploy EnergyShark-Base
```

No se despliega en la ventana del `negotiation-report` de un ciclo.

## Secretos

| Secreto | Contenido | Variable que reemplaza |
| --- | --- | --- |
| `energyshark/wallet-api-key` | API key de la wallet | `WALLET_API_KEY` |
| `energyshark/broker-url` | URL AMQPS completa de `city.REE` | `RABBIT_URL` |

CDK crea cada secreto con un valor aleatorio de relleno. El valor real se carga a mano después del primer deploy y nunca se escribe en el repo ni en el template:

```bash
aws secretsmanager put-secret-value --region us-east-2 \
  --secret-id energyshark/wallet-api-key --secret-string "$WALLET_API_KEY"
```

```bash
aws secretsmanager put-secret-value --region us-east-2 \
  --secret-id energyshark/broker-url --secret-string "$RABBIT_URL"
```

Los secretos tienen `RemovalPolicy.RETAIN`: sobreviven a un `cdk destroy` y hay que borrarlos a mano si de verdad se quieren eliminar.

Una prueba de `test/base-stack.test.ts` falla si alguno de los secretos trae su valor escrito en el template.

## Cómo los usa otro stack

Desde la misma app (`bin/infra.ts`), recibiendo el stack base:

```ts
const base = new BaseStack(app, 'EnergyShark-Base', { env });
new SagaStack(app, 'EnergyShark-Saga', { env, base });
```

```ts
props.base.walletApiKey.grantRead(proponerFn);
proponerFn.addEnvironment('WALLET_API_KEY_ARN', props.base.walletApiKey.secretArn);
```

`grantRead` da permiso solo sobre ese secreto. La Lambda lee el valor en tiempo de ejecución con `GetSecretValue`, nunca como variable de entorno con el valor.

Desde fuera de esta app, con los exports `EnergyShark-WalletApiKeyArn` y `EnergyShark-BrokerUrlArn` (`Fn.importValue`).
