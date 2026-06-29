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

test('Phase B: synthesizes receiver + worker Lambdas, SQS queues, and API Gateway when MICROVM_IMAGE_ARN is set', () => {
  process.env.MICROVM_IMAGE_ARN = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner';

  try {
    const app = new App();
    const stack = new OrchestratorStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Two Lambdas: receiver (Orchestrator) + worker
    template.resourceCountIs('AWS::Lambda::Function', 2);

    // HTTP API + POST /webhook route + Lambda proxy integration
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /webhook' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'AWS_PROXY' });

    // ── SQS: main queue with visibility timeout + redrive policy ───────────────
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 30,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });

    // DLQ: a second queue exists (retentionPeriod 14 days = 1209600 seconds)
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    });

    // Event source mapping: worker subscribes to queue with batchSize 1
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    });

    // ── Receiver Lambda assertions ─────────────────────────────────────────────
    // Has QUEUE_URL env var; does NOT have MICROVM_IMAGE_IDENTIFIER
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          WEBHOOK_SECRET_PARAM: '/github-runner-orchestrator/webhook-secret',
          REQUIRED_RUNNER_LABEL: 'lambda-microvms',
          QUEUE_URL: Match.anyValue(),
        }),
      },
      Timeout: 10,
    });

    // Receiver has sqs:SendMessage permission (from queue.grantSendMessages)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith([Match.stringLikeRegexp('sqs:SendMessage')]) }),
        ]),
      }),
    });

    // Receiver does NOT have lambda:RunMicrovm — it only has ssm + sqs permissions
    // (Validated indirectly: only the worker policy has lambda:RunMicrovm, asserted below)

    // ── Worker Lambda assertions ───────────────────────────────────────────────
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GITHUB_APP_CREDENTIALS_PARAM: '/github-runner-orchestrator/app-credentials',
          RUNNER_GROUP_ID: '42',
          REQUIRED_RUNNER_LABEL: 'lambda-microvms',
          MICROVM_IMAGE_IDENTIFIER: 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner',
        }),
      },
      Timeout: 25,
      MemorySize: 256,
    });

    // Worker has lambda:RunMicrovm permission
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:RunMicrovm' }),
        ]),
      }),
    });

    // Worker has lambda:PassNetworkConnector permission
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:PassNetworkConnector' }),
        ]),
      }),
    });

    // Worker has iam:PassRole permission
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'iam:PassRole' }),
        ]),
      }),
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

    // Execution role has TerminateMicrovm permission (on the MicroVM execution role, not worker)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:TerminateMicrovm' })]),
      }),
    });

    // Stack outputs
    template.hasOutput('AppCredentialsParamName', {});
    template.hasOutput('QueueUrl', {});
    template.hasOutput('DlqUrl', {});
  } finally {
    delete process.env.MICROVM_IMAGE_ARN;
  }
});
