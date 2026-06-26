import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OrchestratorStack } from '../lib/orchestrator-stack';

test('synthesizes the webhook receiver infrastructure', () => {
  const app = new App({
    context: {
      microvmImageIdentifier: 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:test',
      microvmExecutionRoleArn: 'arn:aws:iam::123456789012:role/MicroVMExecutionRole',
      microvmIngressNetworkConnectors: 'arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:NO_INGRESS',
      microvmEgressNetworkConnectors: 'arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS',
    },
  });
  const stack = new OrchestratorStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // Exactly one Lambda (the orchestrator) — no custom resource, no log-retention Lambda.
  template.resourceCountIs('AWS::Lambda::Function', 1);

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
        REQUIRED_RUNNER_LABEL: 'lambda-microvms'
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
});
