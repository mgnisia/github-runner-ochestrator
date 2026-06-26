import * as path from 'node:path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const DEFAULT_PARAM_NAME = '/github-runner-orchestrator/webhook-secret';
const DEFAULT_APP_CREDS_PARAM = '/github-runner-orchestrator/app-credentials';

function requireContext(node: Construct, key: string): string {
  const value = node.node.tryGetContext(key) as string | undefined;
  if (!value) throw new Error(`CDK context value '${key}' is required but not set. Pass it with -c ${key}=<value>`);
  return value;
}

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

    const microvmImageIdentifier = requireContext(this, 'microvmImageIdentifier');
    const microvmExecutionRoleArn = requireContext(this, 'microvmExecutionRoleArn');
    const microvmIngressNetworkConnectors = requireContext(this, 'microvmIngressNetworkConnectors');
    const microvmEgressNetworkConnectors = requireContext(this, 'microvmEgressNetworkConnectors');
    const microvmMaxIdleSeconds =
      (this.node.tryGetContext('microvmMaxIdleSeconds') as string | undefined) ?? '900';
    const microvmSuspendedSeconds =
      (this.node.tryGetContext('microvmSuspendedSeconds') as string | undefined) ?? '1800';
    const microvmMaxDurationSeconds =
      (this.node.tryGetContext('microvmMaxDurationSeconds') as string | undefined) ?? '1800';

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
      bundling: {
        // Bundle @aws-sdk/* into the zip so the deployed version is pinned to >=3.1074.0
        // rather than whatever the Lambda runtime ships with.
        externalModules: [],
      },
      environment: {
        // Pass the literal name string. NEVER webhookSecret.stringValue (throws without a version).
        WEBHOOK_SECRET_PARAM: parameterName,
        GITHUB_APP_CREDENTIALS_PARAM: appCredentialsParamName,
        RUNNER_GROUP_ID: runnerGroupId,
        REQUIRED_RUNNER_LABEL: requiredRunnerLabel,
        MICROVM_IMAGE_IDENTIFIER: microvmImageIdentifier,
        MICROVM_EXECUTION_ROLE_ARN: microvmExecutionRoleArn,
        MICROVM_INGRESS_NETWORK_CONNECTORS: microvmIngressNetworkConnectors,
        MICROVM_EGRESS_NETWORK_CONNECTORS: microvmEgressNetworkConnectors,
        MICROVM_MAX_IDLE_SECONDS: microvmMaxIdleSeconds,
        MICROVM_SUSPENDED_SECONDS: microvmSuspendedSeconds,
        MICROVM_MAX_DURATION_SECONDS: microvmMaxDurationSeconds,
      }
      // Do NOT set `logRetention` here — it injects a second Lambda + custom resource and breaks the
      // "exactly one Lambda" test. If retention is ever needed, create an explicit logs.LogGroup.
    });

    // Grants ssm:GetParameter*/GetParameters/etc. on the parameter ARN.
    webhookSecret.grantRead(orchestrator);
    appCredentials.grantRead(orchestrator);

    const networkConnectorArns = [
      ...microvmIngressNetworkConnectors.split(','),
      ...microvmEgressNetworkConnectors.split(','),
    ].map((s) => s.trim());

    orchestrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:RunMicrovm'],
        resources: [microvmImageIdentifier],
      })
    );

    orchestrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: networkConnectorArns,
      })
    );

    orchestrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [microvmExecutionRoleArn],
      })
    );

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
