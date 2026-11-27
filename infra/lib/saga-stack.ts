import * as path from 'node:path';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { BaseStack } from './base-stack';

export interface SagaStackProps extends StackProps {
  readonly base: BaseStack;
  readonly walletBaseUrl?: string;
  readonly masterBaseUrl?: string;
  readonly cityId?: string;
}

const LAMBDAS_DIR = path.join(__dirname, '..', 'lambdas', 'seller');

export class SagaStack extends Stack {
  readonly internalHmacSecret: secretsmanager.Secret;
  readonly taskTokensTable: dynamodb.Table;
  readonly sellerStateMachine: sfn.StateMachine;
  readonly reservarFn: NodejsFunction;
  readonly proponerFn: NodejsFunction;
  readonly avisarFn: NodejsFunction;
  readonly esperarCierreFn: NodejsFunction;
  readonly reconciliarFn: NodejsFunction;
  readonly cancelarFn: NodejsFunction;
  readonly resultadoFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SagaStackProps) {
    super(scope, id, props);

    const walletBaseUrl = props.walletBaseUrl ?? process.env.WALLET_BASE_URL ?? 'https://wallet.energyshark.cl';
    const masterBaseUrl = props.masterBaseUrl ?? process.env.MASTER_BASE_URL ?? 'https://www.fasantamaria.me';
    const cityId = props.cityId ?? 'REE';

    // Secreto HMAC compartido entre Lambdas de resultado y master (/internal/sagas/:idpk/resultado)
    this.internalHmacSecret = new secretsmanager.Secret(this, 'InternalHmacSecret', {
      secretName: 'energyshark/internal-hmac-secret',
      description: 'Secreto HMAC-SHA256 para autenticar callbacks de sagas hacia master',
      removalPolicy: RemovalPolicy.RETAIN
    });

    // Tabla DynamoDB de task tokens (ADR 0007 / tarea 1.2): PK prefijada idpk:<uuid> | swapId:<id>
    this.taskTokensTable = new dynamodb.Table(this, 'TaskTokensTable', {
      tableName: 'energyshark-saga-task-tokens',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAtEpoch',
      removalPolicy: RemovalPolicy.DESTROY
    });

    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(25),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22'
      }
    };

    // 1. Reservar (sin secretos externos)
    this.reservarFn = new NodejsFunction(this, 'SellerReservarFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'reservar.ts'),
      description: 'Valida la reserva local y calcula plazos dinamicos de la saga del vendedor'
    });

    // 2. Proponer (lee walletApiKey; guarda taskToken en DynamoDB; SendTaskSuccess para HTTP 200)
    this.proponerFn = new NodejsFunction(this, 'SellerProponerFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'proponer.ts'),
      description: 'Guarda taskToken en DynamoDB y propone swap en la wallet con Idempotency-Key',
      environment: {
        WALLET_BASE_URL: walletBaseUrl,
        WALLET_API_KEY_ARN: props.base.walletApiKey.secretArn,
        TASK_TOKENS_TABLE_NAME: this.taskTokensTable.tableName
      }
    });
    props.base.walletApiKey.grantRead(this.proponerFn);
    this.taskTokensTable.grant(this.proponerFn, 'dynamodb:PutItem', 'dynamodb:GetItem');

    // 3. Avisar (lee brokerUrl unicamente)
    this.avisarFn = new NodejsFunction(this, 'SellerAvisarFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'avisar.ts'),
      description: 'Publica bid-accepted al comprador en RabbitMQ con confirmacion',
      environment: {
        BROKER_URL_ARN: props.base.brokerUrl.secretArn,
        CITY_ID: cityId
      }
    });
    props.base.brokerUrl.grantRead(this.avisarFn);

    // 4. EsperarCierre (guarda taskToken en DynamoDB bajo swapId)
    this.esperarCierreFn = new NodejsFunction(this, 'SellerEsperarCierreFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'esperar-cierre.ts'),
      description: 'Guarda taskToken en DynamoDB bajo swapId para esperar liquidacion o vencimiento',
      environment: {
        TASK_TOKENS_TABLE_NAME: this.taskTokensTable.tableName
      }
    });
    this.taskTokensTable.grant(this.esperarCierreFn, 'dynamodb:PutItem', 'dynamodb:GetItem');

    // 5. Reconciliar (lee walletApiKey unicamente)
    this.reconciliarFn = new NodejsFunction(this, 'SellerReconciliarFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'reconciliar.ts'),
      description: 'Consulta el estado real del swap en la wallet ante timeout',
      environment: {
        WALLET_BASE_URL: walletBaseUrl,
        WALLET_API_KEY_ARN: props.base.walletApiKey.secretArn
      }
    });
    props.base.walletApiKey.grantRead(this.reconciliarFn);

    // 6. Cancelar (lee walletApiKey unicamente)
    this.cancelarFn = new NodejsFunction(this, 'SellerCancelarFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'cancelar.ts'),
      description: 'Cancela un swap que sigue proposed en la wallet con Idempotency-Key',
      environment: {
        WALLET_BASE_URL: walletBaseUrl,
        WALLET_API_KEY_ARN: props.base.walletApiKey.secretArn
      }
    });
    props.base.walletApiKey.grantRead(this.cancelarFn);

    // 7. Resultado (usada por Compensar y Liquidado; lee internalHmacSecret unicamente)
    this.resultadoFn = new NodejsFunction(this, 'SellerResultadoFn', {
      ...commonLambdaProps,
      entry: path.join(LAMBDAS_DIR, 'resultado.ts'),
      description: 'Notifica resultado terminal (compensated/settled) a master con firma HMAC',
      environment: {
        MASTER_BASE_URL: masterBaseUrl,
        INTERNAL_HMAC_SECRET_ARN: this.internalHmacSecret.secretArn
      }
    });
    this.internalHmacSecret.grantRead(this.resultadoFn);

    // Politica estandar de reintentos para errores transitorios de wallet (ADR 0007)
    const walletRetryProps: sfn.RetryProps = {
      errors: ['WalletRetryableError'],
      interval: Duration.seconds(1),
      maxAttempts: 4,
      backoffRate: 2,
      maxDelay: Duration.seconds(8),
      jitterStrategy: sfn.JitterType.FULL
    };

    const masterRetryProps: sfn.RetryProps = {
      errors: ['WalletRetryableError'],
      interval: Duration.seconds(1),
      maxAttempts: 3,
      backoffRate: 2,
      maxDelay: Duration.seconds(8),
      jitterStrategy: sfn.JitterType.FULL
    };

    // Estados terminales
    const finCompensado = new sfn.Succeed(this, 'FinCompensado');
    const finLiquidado = new sfn.Succeed(this, 'FinLiquidado');

    const compensar = new tasks.LambdaInvoke(this, 'Compensar', {
      lambdaFunction: this.resultadoFn,
      payload: sfn.TaskInput.fromObject({
        outcome: 'compensated',
        executionName: sfn.JsonPath.executionName,
        state: sfn.JsonPath.entirePayload
      }),
      payloadResponseOnly: true,
      resultPath: '$.compensation',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(30))
    });
    compensar.addRetry(masterRetryProps);
    compensar.next(finCompensado);

    const liquidado = new tasks.LambdaInvoke(this, 'Liquidado', {
      lambdaFunction: this.resultadoFn,
      payload: sfn.TaskInput.fromObject({
        outcome: 'settled',
        executionName: sfn.JsonPath.executionName,
        state: sfn.JsonPath.entirePayload
      }),
      payloadResponseOnly: true,
      resultPath: '$.settlement',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(30))
    });
    liquidado.addRetry(masterRetryProps);
    liquidado.next(finLiquidado);

    // Estado Cancelar
    const cancelar = new tasks.LambdaInvoke(this, 'Cancelar', {
      lambdaFunction: this.cancelarFn,
      payload: sfn.TaskInput.fromObject({
        executionName: sfn.JsonPath.executionName,
        state: sfn.JsonPath.entirePayload
      }),
      payloadResponseOnly: true,
      resultPath: '$.cancellation',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(30))
    });
    cancelar.addRetry(walletRetryProps);
    cancelar.addCatch(compensar, { errors: ['States.ALL'], resultPath: '$.error' });
    cancelar.next(compensar);

    // Estado Reconciliar
    const reconciliar = new tasks.LambdaInvoke(this, 'Reconciliar', {
      lambdaFunction: this.reconciliarFn,
      payload: sfn.TaskInput.fromObject({
        executionName: sfn.JsonPath.executionName,
        state: sfn.JsonPath.entirePayload
      }),
      payloadResponseOnly: true,
      resultPath: '$.reconciliation',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(30))
    });
    reconciliar.addRetry(walletRetryProps);
    reconciliar.addCatch(compensar, { errors: ['States.ALL'], resultPath: '$.error' });

    const evaluarReconciliacion = new sfn.Choice(this, 'EvaluarReconciliacion')
      .when(sfn.Condition.stringEquals('$.reconciliation.status', 'settled'), liquidado)
      .when(
        sfn.Condition.and(
          sfn.Condition.stringEquals('$.reconciliation.status', 'proposed'),
          sfn.Condition.isPresent('$.reconciliation.swapId'),
          sfn.Condition.isNotNull('$.reconciliation.swapId')
        ),
        cancelar
      )
      .otherwise(compensar);
    reconciliar.next(evaluarReconciliacion);

    // Estado EsperarCierre (waitForTaskToken con timeout dinamico expiresAt + 15s, tope closesAt + 30s)
    const esperarCierre = new tasks.LambdaInvoke(this, 'EsperarCierre', {
      lambdaFunction: this.esperarCierreFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        executionName: sfn.JsonPath.executionName,
        input: {
          idpk: sfn.JsonPath.stringAt('$.reservation.idpk'),
          cycleId: sfn.JsonPath.stringAt('$.reservation.cycleId'),
          swapId: sfn.JsonPath.stringAt('$.proposal.swapId'),
          expiresAt: sfn.JsonPath.stringAt('$.proposal.expiresAt')
        }
      }),
      resultPath: '$.closure',
      taskTimeout: sfn.Timeout.at('$.reservation.waitCloseSeconds')
    });
    esperarCierre.addCatch(reconciliar, { errors: ['States.Timeout'], resultPath: '$.error' });
    esperarCierre.addCatch(reconciliar, { errors: ['States.ALL'], resultPath: '$.error' });

    const evaluarCierre = new sfn.Choice(this, 'EvaluarCierre')
      .when(sfn.Condition.stringEquals('$.closure.eventType', 'swap-settled'), liquidado)
      .otherwise(compensar);
    esperarCierre.next(evaluarCierre);

    // Estado Avisar (publica bid-accepted en RabbitMQ)
    const avisar = new tasks.LambdaInvoke(this, 'Avisar', {
      lambdaFunction: this.avisarFn,
      payload: sfn.TaskInput.fromObject({
        idpk: sfn.JsonPath.stringAt('$.reservation.idpk'),
        cycleId: sfn.JsonPath.stringAt('$.reservation.cycleId'),
        offerId: sfn.JsonPath.stringAt('$.reservation.offerId'),
        buyerCityId: sfn.JsonPath.stringAt('$.reservation.buyerCityId'),
        bidMsgId: sfn.JsonPath.stringAt('$.reservation.bidMsgId'),
        quantity: sfn.JsonPath.numberAt('$.reservation.quantity'),
        pricePerEnergy: sfn.JsonPath.numberAt('$.reservation.pricePerEnergy'),
        swapId: sfn.JsonPath.stringAt('$.proposal.swapId'),
        swapToken: sfn.JsonPath.stringAt('$.proposal.token'),
        expiresAt: sfn.JsonPath.stringAt('$.proposal.expiresAt'),
        executionName: sfn.JsonPath.executionName
      }),
      payloadResponseOnly: true,
      resultPath: '$.notice',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(20))
    });
    avisar.addRetry({
      errors: ['States.TaskFailed'],
      interval: Duration.seconds(1),
      maxAttempts: 2,
      backoffRate: 2
    });
    avisar.addCatch(cancelar, { errors: ['States.ALL'], resultPath: '$.error' });
    avisar.next(esperarCierre);

    // Estado Proponer (waitForTaskToken, 30s)
    const proponer = new tasks.LambdaInvoke(this, 'Proponer', {
      lambdaFunction: this.proponerFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        executionName: sfn.JsonPath.executionName,
        input: sfn.JsonPath.objectAt('$.reservation')
      }),
      resultPath: '$.proposal',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(30))
    });
    proponer.addRetry(walletRetryProps);
    // 401/404/422 -> Compensar directo sin reintentar
    proponer.addCatch(compensar, { errors: ['WalletPermanentError'], resultPath: '$.error' });
    // Timeout o reintentos agotados -> Reconciliar para verificar si la wallet si proceso el swap
    proponer.addCatch(reconciliar, { errors: ['States.Timeout'], resultPath: '$.error' });
    proponer.addCatch(reconciliar, { errors: ['States.ALL'], resultPath: '$.error' });

    const evaluarPropuesta = new sfn.Choice(this, 'EvaluarPropuesta')
      .when(sfn.Condition.stringEquals('$.proposal.eventType', 'swap-settled'), liquidado)
      .when(sfn.Condition.stringEquals('$.proposal.eventType', 'swap-proposed'), avisar)
      .otherwise(compensar);
    proponer.next(evaluarPropuesta);

    // Estado inicial: Reservar
    const reservar = new tasks.LambdaInvoke(this, 'Reservar', {
      lambdaFunction: this.reservarFn,
      payloadResponseOnly: true,
      resultPath: '$.reservation',
      taskTimeout: sfn.Timeout.duration(Duration.seconds(15))
    });
    reservar.addCatch(compensar, { errors: ['States.ALL'], resultPath: '$.error' });

    const reservaValida = new sfn.Choice(this, 'ReservaValida')
      .when(sfn.Condition.booleanEquals('$.reservation.valid', true), proponer)
      .otherwise(compensar);
    reservar.next(reservaValida);

    // Maquina de estados Standard del vendedor (ADR 0007: tope global 25 minutos)
    const stateMachineName = 'EnergyShark-SellerSwapSaga';
    this.sellerStateMachine = new sfn.StateMachine(this, 'SellerSwapSaga', {
      stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(reservar),
      timeout: Duration.minutes(25),
      tracingEnabled: true
    });

    // Permiso minimo para que Proponer y EsperarCierre resuelvan callbacks inmediatos (HTTP 200 / race)
    // Usa ARN determinista para evitar dependencia circular en CloudFormation.
    const stateMachineArn = this.formatArn({
      service: 'states',
      resource: 'stateMachine',
      resourceName: stateMachineName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });
    const callbackPolicy = new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: [stateMachineArn]
    });
    this.proponerFn.addToRolePolicy(callbackPolicy);
    this.esperarCierreFn.addToRolePolicy(callbackPolicy);

    new CfnOutput(this, 'SellerSagaStateMachineArn', {
      value: this.sellerStateMachine.stateMachineArn,
      exportName: 'EnergyShark-SellerSagaStateMachineArn'
    });

    new CfnOutput(this, 'InternalHmacSecretArn', {
      value: this.internalHmacSecret.secretArn,
      exportName: 'EnergyShark-InternalHmacSecretArn'
    });

    new CfnOutput(this, 'TaskTokensTableName', {
      value: this.taskTokensTable.tableName,
      exportName: 'EnergyShark-TaskTokensTableName'
    });

    new CfnOutput(this, 'TaskTokensTableArn', {
      value: this.taskTokensTable.tableArn,
      exportName: 'EnergyShark-TaskTokensTableArn'
    });
  }
}
