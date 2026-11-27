#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { BaseStack } from '../lib/base-stack';
import { SagaStack } from '../lib/saga-stack';

const app = new App();
const env = { account: '088674918891', region: 'us-east-2' };
const tags = { proyecto: 'energyshark', grupo: 'arqui-grupo3' };

const base = new BaseStack(app, 'EnergyShark-Base', { env, tags });
new SagaStack(app, 'EnergyShark-Saga', { env, tags, base });
