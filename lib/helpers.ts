import { Construct } from 'constructs';

export function requireContext(node: Construct, key: string): string {
  const value = node.node.tryGetContext(key) as string | undefined;
  if (!value) throw new Error(`CDK context value '${key}' is required but not set. Pass it with -c ${key}=<value>`);
  return value;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable '${name}' is required but not set. Set it before running cdk synth/deploy.`);
  return value;
}
