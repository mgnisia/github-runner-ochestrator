#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { OrchestratorStack } from '../lib/orchestrator-stack';

const app = new App();
new OrchestratorStack(app, 'GithubRunnerOrchestratorStack', {
  // Undefined account/region => env-agnostic stack: synth needs no creds. Real deploys can set these.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});
