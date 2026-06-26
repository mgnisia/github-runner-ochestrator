import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OrchestratorStack } from '../lib/orchestrator-stack';

beforeAll(() => {
  process.env.RUNNER_GROUP_ID = '42';
});

test('Phase A: synthesizes always-on infra without MICROVM_IMAGE_ARN', () => {
  delete process.env.MICROVM_IMAGE_ARN;

  const app = new App();
  const stack = new OrchestratorStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // S3 bucket for MicroVM code artifact — only 1 CloudFormation bucket
  template.resourceCountIs('AWS::S3::Bucket', 1);

  // No Lambda or API Gateway resources when orchestrator is gated out
  template.resourceCountIs('AWS::Lambda::Function', 0);
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);

  // Build role has S3 read permission for the code artifact (granted via bucket.grantRead)
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: Match.arrayWith([Match.stringLikeRegexp('s3:GetObject')]) }),
      ]),
    }),
  });

  // Phase A outputs are present
  template.hasOutput('MicrovmBuildRoleArn', {});
  template.hasOutput('MicrovmCodeBucketName', {});
});

test('Phase B: synthesizes orchestrator Lambda + API Gateway when MICROVM_IMAGE_ARN is set', () => {
  process.env.MICROVM_IMAGE_ARN = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner';

  try {
    const app = new App();
    const stack = new OrchestratorStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Orchestrator Lambda (1) — no BucketDeployment Lambda
    template.resourceCountIs('AWS::Lambda::Function', 1);

    // HTTP API + POST /webhook route + Lambda proxy integration
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /webhook' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'AWS_PROXY' });

    // Orchestrator env vars carry the parameter names and configuration (objectLike tolerates CDK-injected vars)
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          WEBHOOK_SECRET_PARAM: '/github-runner-orchestrator/webhook-secret',
          GITHUB_APP_CREDENTIALS_PARAM: '/github-runner-orchestrator/app-credentials',
          REQUIRED_RUNNER_LABEL: 'lambda-microvms',
          RUNNER_GROUP_ID: '42',
          MICROVM_IMAGE_IDENTIFIER: 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner',
        }),
      },
    });

    // IAM policy grants read on the SSM parameters (grantRead emits multiple ssm:GetParameter* actions)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('ssm:GetParameter')]),
          }),
        ]),
      },
    });

    // Execution role has TerminateMicrovm permission
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:TerminateMicrovm' })]),
      }),
    });

    // AppCredentialsParamName output is present
    template.hasOutput('AppCredentialsParamName', {});
  } finally {
    delete process.env.MICROVM_IMAGE_ARN;
  }
});
