import * as path from 'node:path';
import { spawnSync } from 'child_process';
import { Stack, StackProps, CfnOutput, DockerImage, AssetHashType, BundlingOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { requireEnv } from './helpers';
import { MicrovmImage } from './microvm-image';

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

    const runnerGroupId = requireEnv('RUNNER_GROUP_ID');

    const requiredRunnerLabel =
      (this.node.tryGetContext('requiredRunnerLabel') as string | undefined) ?? 'lambda-microvms';

    const baseImageArn = requireEnv('MICROVM_BASE_IMAGE_ARN');
    const baseImageVersion = requireEnv('MICROVM_BASE_IMAGE_VERSION');

    const microvmMaxIdleSeconds =
      (this.node.tryGetContext('microvmMaxIdleSeconds') as string | undefined) ?? '900';
    const microvmSuspendedSeconds =
      (this.node.tryGetContext('microvmSuspendedSeconds') as string | undefined) ?? '1800';
    const microvmMaxDurationSeconds =
      (this.node.tryGetContext('microvmMaxDurationSeconds') as string | undefined) ?? '1800';

    // Network connector ARNs derived from stack region/partition — no context overrides needed.
    const ingressConnectorArn = `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:NO_INGRESS`;
    const egressConnectorArn = `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

    // ── MicroVM code bucket ────────────────────────────────────────────────────
    // Default removal policy is RETAIN — no explicit removalPolicy needed.
    const codeBucket = new s3.Bucket(this, 'MicrovmCodeBucket');

    const microvmDir = path.join(__dirname, '..', 'microvm');

    new s3deploy.BucketDeployment(this, 'MicrovmCodeDeployment', {
      sources: [
        s3deploy.Source.asset(microvmDir, {
          // Hash the bundling OUTPUT (the produced app.zip), not the source dir, so the asset
          // fingerprint tracks what is actually deployed.
          assetHashType: AssetHashType.OUTPUT,
          bundling: {
            // NOT_ARCHIVED is essential: the bundler emits a single `app.zip` file into the output
            // dir. Under the default AUTO_DISCOVER, CDK would treat that lone archive AS the asset's
            // transport zip — so extract:true would unpack it into the four loose source files and
            // there would be no `app.zip` object at all. Forcing NOT_ARCHIVED makes CDK zip the
            // output *directory* (which contains `app.zip`); extract:true then deposits the file at
            // the deterministic key `app.zip` that CodeArtifact.Uri references below.
            outputType: BundlingOutput.NOT_ARCHIVED,
            // Docker fallback — only used if local bundling returns false.
            image: DockerImage.fromRegistry('alpine'),
            local: {
              tryBundle(outputDir: string): boolean {
                // Produce app.zip containing exactly the four runtime files (explicit list,
                // matching the experiment's deploy.sh) so no stray files (e.g. macOS .DS_Store)
                // or a self-referential app.zip can leak into the archive.
                const result = spawnSync(
                  'zip',
                  [
                    '-r',
                    path.join(outputDir, 'app.zip'),
                    'Dockerfile',
                    'app.js',
                    'entrypoint.sh',
                    'package.json',
                  ],
                  { cwd: microvmDir, stdio: 'inherit' }
                );
                return result.status === 0;
              },
            },
          },
        }),
      ],
      destinationBucket: codeBucket,
      destinationKeyPrefix: '',
      // extract: true — paired with BundlingOutput.NOT_ARCHIVED above, CDK transports the output
      // *directory* (containing `app.zip`) and extracts it into the bucket root, leaving exactly one
      // object at the deterministic key `app.zip` that CodeArtifact.Uri references below. With
      // extract:false the object would instead land under an unpredictable `<hash>.zip` key.
      extract: true,
    });

    const codeArtifactUri = codeBucket.s3UrlForObject('app.zip');

    // ── Build role ─────────────────────────────────────────────────────────────
    // Used by Lambda to pull the code artifact from S3 during MicrovmImage build.
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

    // ── MicrovmImage L1 construct ──────────────────────────────────────────────
    const microvmImage = new MicrovmImage(this, 'MicrovmImage', {
      buildRoleArn: buildRole.roleArn,
      codeArtifactUri,
      baseImageArn,
      baseImageVersion,
      egressConnectorArn,
    });

    // ── Execution role ─────────────────────────────────────────────────────────
    // Assumed by the MicroVM instance at runtime.
    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      // TODO VERIFY AT DEPLOY: confirm the correct service principal for the MicroVM runtime
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:TerminateMicrovm'],
        resources: [microvmImage.imageArn],
      })
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      })
    );

    // ── SSM SecureString references ────────────────────────────────────────────
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

    // ── Orchestrator Lambda ────────────────────────────────────────────────────
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
        GITHUB_APP_CREDENTIALS_PARAM: appCredentialsParamName,
        RUNNER_GROUP_ID: runnerGroupId,
        REQUIRED_RUNNER_LABEL: requiredRunnerLabel,
        MICROVM_IMAGE_IDENTIFIER: microvmImage.imageArn,
        MICROVM_EXECUTION_ROLE_ARN: executionRole.roleArn,
        MICROVM_INGRESS_NETWORK_CONNECTORS: ingressConnectorArn,
        MICROVM_EGRESS_NETWORK_CONNECTORS: egressConnectorArn,
        MICROVM_MAX_IDLE_SECONDS: microvmMaxIdleSeconds,
        MICROVM_SUSPENDED_SECONDS: microvmSuspendedSeconds,
        MICROVM_MAX_DURATION_SECONDS: microvmMaxDurationSeconds,
      },
      // Do NOT set `logRetention` here — it injects a second Lambda + custom resource.
      // If retention is ever needed, create an explicit logs.LogGroup.
    });

    // Grants ssm:GetParameter*/GetParameters/etc. on the parameter ARN.
    webhookSecret.grantRead(orchestrator);
    appCredentials.grantRead(orchestrator);

    orchestrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:RunMicrovm'],
        resources: [microvmImage.imageArn],
      })
    );

    orchestrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: [ingressConnectorArn, egressConnectorArn],
      })
    );

    orchestrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [executionRole.roleArn],
      })
    );

    // ── API Gateway ────────────────────────────────────────────────────────────
    const httpApi = new HttpApi(this, 'WebhookApi');
    httpApi.addRoutes({
      path: '/webhook',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', orchestrator)
    });

    // ── Stack outputs ──────────────────────────────────────────────────────────
    new CfnOutput(this, 'WebhookUrl', { value: `${httpApi.apiEndpoint}/webhook` });
    new CfnOutput(this, 'WebhookSecretParamName', { value: parameterName });
    new CfnOutput(this, 'AppCredentialsParamName', { value: appCredentialsParamName });
    new CfnOutput(this, 'MicrovmImageArn', { value: microvmImage.imageArn });
    new CfnOutput(this, 'MicrovmCodeBucketName', { value: codeBucket.bucketName });
  }
}
