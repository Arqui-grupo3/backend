#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { BaseStack } from '../lib/base-stack';

const app = new App();

new BaseStack(app, 'EnergyShark-Base', {
  env: { account: '088674918891', region: 'us-east-2' },
  tags: { proyecto: 'energyshark', grupo: 'arqui-grupo3' }
});
