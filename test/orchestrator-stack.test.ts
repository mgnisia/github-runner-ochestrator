import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OrchestratorStack } from '../lib/orchestrator-stack';

beforeAll(() => {
  process.env.MICROVM_BASE_IMAGE_ARN = 'arn:aws:lambda:eu-west-1:123456789012:microvm-base-image:al2023';
  process.env.MICROVM_BASE_IMAGE_VERSION = '1';
  process.env.RUNNER_GROUP_ID = '42';
});

test('synthesizes the webhook receiver infrastructure', () => {
  const app = new App();
  const stack = new OrchestratorStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // Orchestrator Lambda + BucketDeployment custom resource Lambda
  template.resourceCountIs('AWS::Lambda::Function', 2);

  // HTTP API + POST /webhook route + Lambda proxy integration.
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /webhook' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'AWS_PROXY' });

  // Orchestrator env vars carry the parameter names and configuration (objectLike tolerates CDK-injected vars).
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        WEBHOOK_SECRET_PARAM: '/github-runner-orchestrator/webhook-secret',
        GITHUB_APP_CREDENTIALS_PARAM: '/github-runner-orchestrator/app-credentials',
        REQUIRED_RUNNER_LABEL: 'lambda-microvms',
        RUNNER_GROUP_ID: '42',
      })
    }
  });

  // IAM policy grants read on the SSM parameters (grantRead emits multiple ssm:GetParameter* actions).
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([Match.stringLikeRegexp('ssm:GetParameter')])
        })
      ])
    }
  });

  // AppCredentialsParamName output is present.
  template.hasOutput('AppCredentialsParamName', {
    Value: '/github-runner-orchestrator/app-credentials'
  });

  // MicroVM image resource is declared in the template with the expected name and ARM64 CPU config.
  template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
    Name: 'github-runner',
    CpuConfigurations: [{ Architecture: 'ARM_64' }],
  });

  // S3 bucket for MicroVM code artifact — only 1 CloudFormation bucket;
  // BucketDeployment stages assets in the CDK bootstrap bucket, not a separate CFN resource.
  template.resourceCountIs('AWS::S3::Bucket', 1);

  // Build role has S3 read permission for the code artifact (granted via bucket.grantRead).
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: Match.arrayWith([Match.stringLikeRegexp('s3:GetObject')]) })
      ])
    })
  });

  // Execution role has TerminateMicrovm permission.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'lambda:TerminateMicrovm' })
      ])
    })
  });
});
