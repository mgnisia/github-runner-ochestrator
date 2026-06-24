import * as path from 'node:path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const DEFAULT_PARAM_NAME = '/github-runner-orchestrator/webhook-secret';
const DEFAULT_APP_CREDS_PARAM = '/github-runner-orchestrator/app-credentials';

export class OrchestratorStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const parameterName =
      (this.node.tryGetContext('webhookSecretParamName') as string | undefined) ??
      DEFAULT_PARAM_NAME;

    const appCredentialsParamName =
      (this.node.tryGetContext('appCredentialsParamName') as string | undefined) ??
      DEFAULT_APP_CREDS_PARAM;

    const runnerGroupId = String(this.node.tryGetContext('runnerGroupId') ?? '1');

    const requiredRunnerLabel =
      (this.node.tryGetContext('requiredRunnerLabel') as string | undefined) ?? 'lambda-microvms';

    // Reference (do NOT create) the existing SecureString. No `version` => value is never resolved
    // at synth, so the plaintext never enters the template. Does NOT perform a context lookup.
    const webhookSecret = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'WebhookSecret',
      { parameterName }
    );

    const appCredentials = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'AppCredentials',
      { parameterName: appCredentialsParamName }
    );

    const orchestrator = new NodejsFunction(this, 'Orchestrator', {
      // __dirname is lib/ at runtime (ts-node), so go up one level to reach src/.
      entry: path.join(__dirname, '..', 'src', 'webhook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X, // fall back to NODEJS_20_X if this enum is missing
      environment: {
        // Pass the literal name string. NEVER webhookSecret.stringValue (throws without a version).
        WEBHOOK_SECRET_PARAM: parameterName,
        GITHUB_APP_CREDENTIALS_PARAM: appCredentialsParamName,
        RUNNER_GROUP_ID: runnerGroupId,
        REQUIRED_RUNNER_LABEL: requiredRunnerLabel
      }
      // Do NOT set `logRetention` here — it injects a second Lambda + custom resource and breaks the
      // "exactly one Lambda" test. If retention is ever needed, create an explicit logs.LogGroup.
    });

    // Grants ssm:GetParameter*/GetParameters/etc. on the parameter ARN.
    webhookSecret.grantRead(orchestrator);
    appCredentials.grantRead(orchestrator);

    const httpApi = new HttpApi(this, 'WebhookApi');
    httpApi.addRoutes({
      path: '/webhook',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', orchestrator)
    });

    new CfnOutput(this, 'WebhookUrl', { value: `${httpApi.apiEndpoint}/webhook` });
    new CfnOutput(this, 'WebhookSecretParamName', { value: parameterName });
    new CfnOutput(this, 'AppCredentialsParamName', { value: appCredentialsParamName });
  }
}
