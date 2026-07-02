/**
 * build-lambdas.ts
 *
 * Replaces CDK's NodejsFunction bundling. Bundles each Lambda entrypoint with
 * esbuild into dist/<name>/index.js (CommonJS, node22), so OpenTofu's
 * archive_file data source can zip a ready-to-deploy artifact.
 *
 * The @aws-sdk/* packages are bundled in (not marked external) to pin the
 * deployed SDK version rather than relying on whatever the Lambda runtime ships.
 * This mirrors the previous CDK config `bundling: { externalModules: [] }`.
 *
 * Run via:
 *   bun run build:lambdas
 */

import * as path from 'node:path';
import { build } from 'esbuild';

interface LambdaBundle {
  name: string;
  entry: string;
}

const ROOT = path.join(__dirname, '..');

const BUNDLES: LambdaBundle[] = [
  { name: 'orchestrator', entry: path.join(ROOT, 'src', 'webhook.ts') },
  { name: 'worker', entry: path.join(ROOT, 'src', 'worker.ts') },
];

async function main(): Promise<void> {
  for (const bundle of BUNDLES) {
    const outfile = path.join(ROOT, 'dist', bundle.name, 'index.js');
    console.log(`Bundling ${bundle.entry} -> ${outfile}`);
    await build({
      entryPoints: [bundle.entry],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      // Bundle everything, including @aws-sdk/*, to pin versions in the artifact.
      external: [],
      sourcemap: false,
      minify: false,
      logLevel: 'info',
    });
  }
  console.log('Lambda bundles ready in dist/.');
}

main().catch((err: unknown) => {
  console.error('build-lambdas failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
