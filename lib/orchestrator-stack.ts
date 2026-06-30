import * as path from 'node:path';
import { Duration, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { requireEnv } from './helpers';

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

    const requiredRunnerLabel =
      (this.node.tryGetContext('requiredRunnerLabel') as string | undefined) ?? 'lambda-microvms';

    const dockerRunnerLabel =
      (this.node.tryGetContext('dockerRunnerLabel') as string | undefined) ?? 'docker';

    const microvmMaxIdleSeconds =
      (this.node.tryGetContext('microvmMaxIdleSeconds') as string | undefined) ?? '900';
    const microvmSuspendedSeconds =
      (this.node.tryGetContext('microvmSuspendedSeconds') as string | undefined) ?? '3600';
    const microvmMaxDurationSeconds =
      (this.node.tryGetContext('microvmMaxDurationSeconds') as string | undefined) ?? '3600';

    // ── Phase A: always synthesized ────────────────────────────────────────────

    // ── MicroVM code bucket ────────────────────────────────────────────────────
    // Default removal policy is RETAIN — no explicit removalPolicy needed.
    const codeBucket = new s3.Bucket(this, 'MicrovmCodeBucket');

    // ── Build role ─────────────────────────────────────────────────────────────
    // Used by Lambda to pull the code artifact from S3 during the script-driven MicroVM image build.
    const buildRole = new iam.Role(this, 'MicrovmBuildRole', {
      // TODO VERIFY AT DEPLOY: confirm the correct service principal for the MicroVM build service
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    codeBucket.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:${this.partition}:logs:*:*:*`],
      })
    );

    new CfnOutput(this, 'MicrovmCodeBucketName', { value: codeBucket.bucketName });
    new CfnOutput(this, 'MicrovmBuildRoleArn', { value: buildRole.roleArn });
    // Base image ARN — AWS-owned image; account segment is the literal `aws`.
    new CfnOutput(this, 'MicrovmBaseImageArn', {
      value: `arn:${this.partition}:lambda:${this.region}:aws:microvm-image:al2023-1`,
    });
    new CfnOutput(this, 'Region', { value: this.region });

    // ── Phase B: synthesized only when BOTH image ARNs are set ───────────────
    if (process.env.MICROVM_IMAGE_ARN_DOCKER && process.env.MICROVM_IMAGE_ARN_NO_DOCKER) {
      const dockerArn = process.env.MICROVM_IMAGE_ARN_DOCKER;
      const noDockerArn = process.env.MICROVM_IMAGE_ARN_NO_DOCKER;
      const runnerGroupId = requireEnv('RUNNER_GROUP_ID');

      // Network connector ARNs derived from stack region/partition — no context overrides needed.
      const ingressConnectorArn = `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:NO_INGRESS`;
      const egressConnectorArn = `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

      // ── Execution role ───────────────────────────────────────────────────────
      // Assumed by the MicroVM instance at runtime.
      const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
        // TODO VERIFY AT DEPLOY: confirm the correct service principal for the MicroVM runtime
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      executionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:TerminateMicrovm'],
          resources: [dockerArn, noDockerArn],
        })
      );
      executionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: ['*'],
        })
      );

      // ── SSM SecureString references ──────────────────────────────────────────
      // Reference (do NOT create) the existing SecureStrings. No `version` => value is never
      // resolved at synth time, so the plaintext never enters the template.
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

      // ── SQS Queues ──────────────────────────────────────────────────────────
      const dlq = new sqs.Queue(this, 'WebhookDlq', {
        retentionPeriod: Duration.days(14),
      });

      const queue = new sqs.Queue(this, 'WebhookQueue', {
        visibilityTimeout: Duration.seconds(30),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });

      // ── Receiver Lambda (Orchestrator) ───────────────────────────────────────
      // Logical id kept as 'Orchestrator' to avoid replacing the API integration resource.
      const orchestrator = new NodejsFunction(this, 'Orchestrator', {
        // __dirname is lib/ at runtime (ts-node), so go up one level to reach src/.
        entry: path.join(__dirname, '..', 'src', 'webhook.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        bundling: {
          // Bundle @aws-sdk/* into the zip so the deployed version is pinned to >=3.1074.0
          // rather than whatever the Lambda runtime ships with.
          externalModules: [],
        },
        environment: {
          // Pass the literal name string. NEVER webhookSecret.stringValue (throws without a version).
          WEBHOOK_SECRET_PARAM: parameterName,
          REQUIRED_RUNNER_LABEL: requiredRunnerLabel,
          QUEUE_URL: queue.queueUrl,
        },
        timeout: Duration.seconds(10),
        memorySize: 256,
        // Do NOT set `logRetention` here — it injects a second Lambda + custom resource.
        // If retention is ever needed, create an explicit logs.LogGroup.
      });

      // Receiver only needs webhook secret + SQS send permission.
      webhookSecret.grantRead(orchestrator);
      queue.grantSendMessages(orchestrator);

      // ── Worker Lambda ────────────────────────────────────────────────────────
      // Consumes SQS messages, mints JIT tokens, launches MicroVMs with retry.
      const worker = new NodejsFunction(this, 'Worker', {
        entry: path.join(__dirname, '..', 'src', 'worker.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        bundling: { externalModules: [] },
        environment: {
          GITHUB_APP_CREDENTIALS_PARAM: appCredentialsParamName,
          RUNNER_GROUP_ID: runnerGroupId,
          REQUIRED_RUNNER_LABEL: requiredRunnerLabel,
          MICROVM_IMAGE_IDENTIFIER_DOCKER: dockerArn,
          MICROVM_IMAGE_IDENTIFIER_NO_DOCKER: noDockerArn,
          DOCKER_RUNNER_LABEL: dockerRunnerLabel,
          MICROVM_EXECUTION_ROLE_ARN: executionRole.roleArn,
          MICROVM_INGRESS_NETWORK_CONNECTORS: ingressConnectorArn,
          MICROVM_EGRESS_NETWORK_CONNECTORS: egressConnectorArn,
          MICROVM_MAX_IDLE_SECONDS: microvmMaxIdleSeconds,
          MICROVM_SUSPENDED_SECONDS: microvmSuspendedSeconds,
          MICROVM_MAX_DURATION_SECONDS: microvmMaxDurationSeconds,
        },
        timeout: Duration.seconds(25),
        memorySize: 256,
      });

      appCredentials.grantRead(worker);
      worker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['lambda:RunMicrovm'],
          resources: [dockerArn, noDockerArn],
        })
      );
      worker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['lambda:PassNetworkConnector'],
          resources: [ingressConnectorArn, egressConnectorArn],
        })
      );
      worker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [executionRole.roleArn],
        })
      );
      worker.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

      // ── API Gateway ────────────────────────────────────────────────────────
      const httpApi = new HttpApi(this, 'WebhookApi');
      httpApi.addRoutes({
        path: '/webhook',
        methods: [HttpMethod.POST],
        integration: new HttpLambdaIntegration('WebhookIntegration', orchestrator),
      });

      // ── Stack outputs ────────────────────────────────────────────────────────
      new CfnOutput(this, 'WebhookUrl', { value: `${httpApi.apiEndpoint}/webhook` });
      new CfnOutput(this, 'WebhookSecretParamName', { value: parameterName });
      new CfnOutput(this, 'AppCredentialsParamName', { value: appCredentialsParamName });
      new CfnOutput(this, 'MicrovmImageArnDocker', { value: dockerArn });
      new CfnOutput(this, 'MicrovmImageArnNoDocker', { value: noDockerArn });
      new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
      new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    }
  }
}
