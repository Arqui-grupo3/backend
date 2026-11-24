import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BaseStack } from '../lib/base-stack';

const template = Template.fromStack(new BaseStack(new App(), 'Test'));

test('declara los dos secretos', () => {
  template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'energyshark/wallet-api-key' });
  template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'energyshark/broker-url' });
});

test('ningún secreto trae su valor en el template', () => {
  template.allResourcesProperties('AWS::SecretsManager::Secret', { SecretString: Match.absent() });
});

test('los secretos sobreviven a un cdk destroy', () => {
  template.allResources('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
});

test('exporta los ARN para el stack de la saga', () => {
  template.hasOutput('WalletApiKeyArn', { Export: { Name: 'EnergyShark-WalletApiKeyArn' } });
  template.hasOutput('BrokerUrlArn', { Export: { Name: 'EnergyShark-BrokerUrlArn' } });
});
