import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib/core';
import { AlarmToDevOpsAgentStack } from '../lib/alarm-to-devops-agent-stack';

/**
 * Guards the one failure this project cannot catch any other way.
 *
 * NodejsFunction leaves `@aws-sdk/*` out of the bundle by default, on the assumption the
 * Lambda runtime provides it. The runtime's bundled SDK does not include
 * client-devops-agent, so with the default setting `api` mode would deploy cleanly and
 * then fail at cold start with a module-not-found. Nothing in the unit tests or the
 * CloudFormation template shows that. This test synthesizes for real and reads the
 * emitted asset.
 */
describe('lambda bundle', () => {
  let bundle: string;
  let outdir: string;

  beforeAll(() => {
    outdir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bundle-test-'));
    const app = new App({ outdir });
    new AlarmToDevOpsAgentStack(app, 'BundleStack', {
      env: { account: '123456789012', region: 'ap-southeast-1' },
      agentSpaceId: 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111',
    });

    const assembly = app.synth();
    // Read the emitted asset straight off disk. Recent CDK versions record assets in a
    // separate asset-manifest artifact rather than on the stack artifact, so scanning the
    // assembly directory is the stable way to find the bundle.
    const assetDir = fs
      .readdirSync(assembly.directory)
      .filter((entry) => entry.startsWith('asset.'))
      .map((entry) => path.join(assembly.directory, entry))
      .find((dir) => fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'index.js')));
    if (!assetDir) throw new Error(`no bundled asset with an index.js in ${assembly.directory}`);

    bundle = fs.readFileSync(path.join(assetDir, 'index.js'), 'utf8');
  });

  // The bundle plus its source map is ~2.5 MB; without this every test run leaks a copy.
  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  // esbuild would leave a bare require() behind if the module were treated as external.
  it.each([
    '@aws-sdk/client-devops-agent',
    '@aws-sdk/client-secrets-manager',
    '@aws-lambda-powertools/logger',
    '@aws-lambda-powertools/batch',
  ])(
    'inlines %s rather than expecting the runtime to provide it',
    (moduleName) => {
      expect(bundle).not.toContain(`require("${moduleName}")`);
      expect(bundle).not.toContain(`require('${moduleName}')`);
    },
  );

  it('contains the DevOps Agent client, identified by its signing name', () => {
    // Survives minification because it is a string literal in the generated client.
    expect(bundle).toContain('aidevops');
  });

  it('contains the handler entry point', () => {
    expect(bundle).toMatch(/handler/);
  });

  it('is a single self-contained file', () => {
    expect(bundle.length).toBeGreaterThan(100_000);
  });
});
