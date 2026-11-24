import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class BaseStack extends Stack {
  readonly walletApiKey: secretsmanager.Secret;
  readonly brokerUrl: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.walletApiKey = new secretsmanager.Secret(this, 'WalletApiKey', {
      secretName: 'energyshark/wallet-api-key',
      description: 'API key de la wallet de la central (WALLET_API_KEY)',
      removalPolicy: RemovalPolicy.RETAIN
    });

    this.brokerUrl = new secretsmanager.Secret(this, 'BrokerUrl', {
      secretName: 'energyshark/broker-url',
      description: 'URL AMQPS con credenciales de city.REE (RABBIT_URL)',
      removalPolicy: RemovalPolicy.RETAIN
    });

    new CfnOutput(this, 'WalletApiKeyArn', {
      value: this.walletApiKey.secretArn,
      exportName: 'EnergyShark-WalletApiKeyArn'
    });

    new CfnOutput(this, 'BrokerUrlArn', {
      value: this.brokerUrl.secretArn,
      exportName: 'EnergyShark-BrokerUrlArn'
    });
  }
}
