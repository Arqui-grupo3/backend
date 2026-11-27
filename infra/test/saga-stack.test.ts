import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BaseStack } from '../lib/base-stack';
import { SagaStack } from '../lib/saga-stack';

const app = new App();
const env = { account: '088674918891', region: 'us-east-2' };
const base = new BaseStack(app, 'TestBase', { env });
const saga = new SagaStack(app, 'TestSaga', { env, base });
const template = Template.fromStack(saga);

function extractDefinitionString(): string {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const first = Object.values(machines)[0] as any;
  const def = first.Properties.DefinitionString;
  if (typeof def === 'string') return def;
  if (def && Array.isArray(def['Fn::Join']?.[1])) {
    return def['Fn::Join'][1].map((part: unknown) => (typeof part === 'string' ? part : JSON.stringify(part))).join('');
  }
  return JSON.stringify(def);
}

test('crea la maquina Step Functions STANDARD del vendedor con los 8 estados de ADR 0007', () => {
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
    StateMachineName: 'EnergyShark-SellerSwapSaga',
    StateMachineType: 'STANDARD'
  });

  const asl = extractDefinitionString();
  for (const state of ['Reservar', 'Proponer', 'Avisar', 'EsperarCierre', 'Reconciliar', 'Cancelar', 'Compensar', 'Liquidado']) {
    expect(asl).toContain(`"${state}"`);
  }
  expect(asl).toContain('"TimeoutSeconds":1500');
  expect(asl).toContain('"TimeoutSecondsPath":"$.reservation.waitCloseSeconds"');
  expect(asl).toContain('waitForTaskToken');
  expect(asl).toContain('WalletRetryableError');
  expect(asl).toContain('WalletPermanentError');
});

test('declara el secreto HMAC sin SecretString embebido y con Retention RETAIN', () => {
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'energyshark/internal-hmac-secret',
    SecretString: Match.absent()
  });
  template.allResources('AWS::SecretsManager::Secret', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain'
  });
});

test('exporta los ARN de la maquina de estados y del secreto HMAC', () => {
  template.hasOutput('SellerSagaStateMachineArn', {
    Export: { Name: 'EnergyShark-SellerSagaStateMachineArn' }
  });
  template.hasOutput('InternalHmacSecretArn', {
    Export: { Name: 'EnergyShark-InternalHmacSecretArn' }
  });
});

test('aplica permisos minimos: Avisar solo lee brokerUrl y no walletApiKey', () => {
  const policies = template.findResources('AWS::IAM::Policy');
  const entries = Object.entries(policies);

  const avisarPolicy = entries.find(([logicalId]) => logicalId.includes('SellerAvisarFn'));
  expect(avisarPolicy).toBeDefined();
  const avisarPolicyText = JSON.stringify(avisarPolicy![1]);
  expect(avisarPolicyText).toContain('secretsmanager:GetSecretValue');
  expect(avisarPolicyText).toContain('BrokerUrl');
  expect(avisarPolicyText).not.toContain('WalletApiKey');

  const proponerPolicy = entries.find(([logicalId]) => logicalId.includes('SellerProponerFn'));
  expect(proponerPolicy).toBeDefined();
  const proponerPolicyText = JSON.stringify(proponerPolicy![1]);
  expect(proponerPolicyText).toContain('WalletApiKey');
  expect(proponerPolicyText).toContain('states:SendTaskSuccess');
  expect(proponerPolicyText).not.toContain('BrokerUrl');
});
