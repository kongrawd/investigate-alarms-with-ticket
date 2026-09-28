import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib/core';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CustomSkillsStack } from '../lib/custom-skills-stack';
import { readSkillArchive } from '../lib/skills/skill-archive';

const env = { account: '123456789012', region: 'ap-southeast-1' };
const AGENT_SPACE_ID = 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111';

const DESCRIPTION =
  'Investigation procedure for the checkout service. Use this skill when an alarm names the ' +
  'checkout load balancer, when 5xx rates rise, or when latency exceeds its threshold.';

let skillsRoot: string;

beforeEach(() => {
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-stack-'));
});

afterEach(() => {
  fs.rmSync(skillsRoot, { recursive: true, force: true });
});

function writeSkill(name: string, extraFrontmatter = ''): void {
  const directory = path.join(skillsRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${DESCRIPTION}${extraFrontmatter}\n---\n\n# ${name}\n`,
  );
}

function template(props: { active?: boolean } = {}): Template {
  return Template.fromStack(
    new CustomSkillsStack(new App(), 'SkillsStack', {
      env,
      agentSpaceId: AGENT_SPACE_ID,
      skillsRoot,
      ...(props.active !== undefined ? { active: props.active } : {}),
    }),
  );
}

describe('skill assets', () => {
  it('creates one asset per skill directory, attached to the existing Agent Space', () => {
    writeSkill('checkout-triage');
    writeSkill('rds-triage');

    const synthesized = template();

    synthesized.resourceCountIs('AWS::DevOpsAgent::Asset', 2);
    synthesized.hasResourceProperties('AWS::DevOpsAgent::Asset', {
      AgentSpaceId: AGENT_SPACE_ID,
      AssetType: 'skill',
    });
  });

  it('sends only the metadata the zip path honours, in snake_case', () => {
    writeSkill('checkout-triage', '\nmetadata:\n  agent_types: INCIDENT_TRIAGE');

    // name and description are deliberately absent: the service reads them from the SKILL.md
    // frontmatter for a zip upload and ignores these, so sending them invites two copies to
    // disagree.
    template().hasResourceProperties('AWS::DevOpsAgent::Asset', {
      Metadata: { agent_types: ['INCIDENT_TRIAGE'], status: 'ACTIVE' },
    });
  });

  it('ships one zip, because a multi-entry Files list silently drops files', () => {
    writeSkill('checkout-triage');
    fs.mkdirSync(path.join(skillsRoot, 'checkout-triage', 'references'));
    fs.writeFileSync(path.join(skillsRoot, 'checkout-triage', 'references', 'metrics.md'), '# metrics\n');

    const asset = Object.values(template().findResources('AWS::DevOpsAgent::Asset'))[0]!;

    expect(asset['Properties']['Files']).toBeUndefined();
    expect(Object.keys(readSkillArchive(asset['Properties']['Zip'] as string))).toEqual([
      'SKILL.md',
      'references/metrics.md',
    ]);
  });

  it('can upload skills inactive for review', () => {
    writeSkill('checkout-triage');

    template({ active: false }).hasResourceProperties('AWS::DevOpsAgent::Asset', {
      Metadata: Match.objectLike({ status: 'INACTIVE' }),
    });
  });

  it('outputs each asset id, which is how a trigger references a skill later', () => {
    writeSkill('checkout-triage');

    template().hasOutput('SkillCheckoutTriageAssetId', {});
  });

  it('keeps construct ids keyed on the skill name, so adding one does not disturb another', () => {
    writeSkill('checkout-triage');
    writeSkill('rds-triage');

    expect(Object.keys(template().findResources('AWS::DevOpsAgent::Asset')).sort()).toEqual([
      'SkillCheckoutTriage',
      'SkillRdsTriage',
    ]);
  });
});

describe('guard rails', () => {
  it('requires an existing Agent Space', () => {
    expect(
      () => new CustomSkillsStack(new App(), 'S', { env, agentSpaceId: ' ', skillsRoot }),
    ).toThrow(/agentSpaceId is required/);
  });

  it('warns rather than failing when no skills are present', () => {
    const stack = new CustomSkillsStack(new App(), 'EmptyStack', { env, agentSpaceId: AGENT_SPACE_ID, skillsRoot });

    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('No skills found'));
  });

  it('surfaces a thin description as a warning, since the agent may then skip the skill', () => {
    writeSkill('checkout-triage');
    fs.writeFileSync(
      path.join(skillsRoot, 'checkout-triage', 'SKILL.md'),
      '---\nname: checkout-triage\ndescription: Checkout skill\n---\n\n# checkout-triage\n',
    );
    const stack = new CustomSkillsStack(new App(), 'ThinStack', { env, agentSpaceId: AGENT_SPACE_ID, skillsRoot });

    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('100 is recommended'));
  });

  it('reports no cdk-nag findings', () => {
    writeSkill('checkout-triage');
    const stack = new CustomSkillsStack(new App(), 'NagStack', { env, agentSpaceId: AGENT_SPACE_ID, skillsRoot });

    const report = new AwsSolutionsChecks(stack, { verbose: true }).validateScope(stack);

    expect(report.violations.map((violation) => violation.ruleName)).toEqual([]);
  });
});

describe('construct ids', () => {
  it('names both skills when two of them reduce to one construct id', () => {
    // Uppercasing a digit does nothing and a hyphen does not survive into a logical id, so these
    // two collide. CDK's own error names neither of them.
    writeSkill('rds-1');
    writeSkill('rds1');

    expect(() => template()).toThrow(/both map to the construct id SkillRds1/);
  });
});
