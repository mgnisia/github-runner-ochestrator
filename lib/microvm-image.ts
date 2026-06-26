import { Construct } from 'constructs';
import { CfnResource } from 'aws-cdk-lib';

export interface MicrovmImageProps {
  buildRoleArn: string;
  codeArtifactUri: string;
  baseImageArn: string;
  baseImageVersion: string;
  egressConnectorArn: string;
}

export class MicrovmImage extends Construct {
  public readonly imageArn: string;

  constructor(scope: Construct, id: string, props: MicrovmImageProps) {
    super(scope, id);

    // VERIFY AT DEPLOY: the exact accepted CodeArtifact.Uri form (zip object vs prefix)
    // and the minimal Hooks/Logging shape are unconfirmed for this brand-new service;
    // confirm on first deploy and adjust if CloudFormation rejects.
    const resource = new CfnResource(this, 'Resource', {
      type: 'AWS::Lambda::MicrovmImage',
      properties: {
        Name: 'github-runner',
        BaseImageArn: props.baseImageArn,
        BaseImageVersion: props.baseImageVersion,
        BuildRoleArn: props.buildRoleArn,
        CodeArtifact: { Uri: props.codeArtifactUri },
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        Resources: [{ MinimumMemoryInMiB: 2048 }],
        AdditionalOsCapabilities: ['ALL'],
        EgressNetworkConnectors: [props.egressConnectorArn],
        EnvironmentVariables: [],
        Hooks: {
          Port: 9000,
          MicrovmHooks: { Run: 'ENABLED', Terminate: 'ENABLED' },
          MicrovmImageHooks: { Ready: 'ENABLED' },
        },
        Logging: { CloudWatch: {} },
      },
    });

    this.imageArn = resource.getAtt('ImageArn').toString();
  }
}
