import * as path from 'node:path';
import { Annotations, CfnOutput, Stack, type StackProps } from 'aws-cdk-lib/core';
import * as devopsagent from 'aws-cdk-lib/aws-devopsagent';
import { Construct } from 'constructs';
import { buildSkillArchive } from './skills/skill-archive';
import { readSkills, type SkillDefinition } from './skills/skill-definition';

export interface CustomSkillsStackProps extends StackProps {
  /** Id of an existing Agent Space. Skills are created as children of it. */
  readonly agentSpaceId: string;

  /**
   * Directory holding one subdirectory per skill. Defaults to `skills/` at the repository
   * root, so the content sits outside the CDK app that ships it.
   */
  readonly skillsRoot?: string | undefined;

  /**
   * Whether the agent may load the skills as soon as they are uploaded.
   *
   * The default makes them live on the first deploy, which changes how the agent behaves
   * immediately. Pass `false` to upload them inactive instead, for review in the Operator Web
   * App first.
   *
   * @default true
   */
  readonly active?: boolean | undefined;
}

/**
 * Optional stack that preloads skills into an existing Agent Space, so an investigation
 * arrives with the runbooks it needs already in place.
 *
 * Kept separate from the alarm pipeline on purpose. Skills are knowledge with a different
 * change cadence, and deleting this stack removes them from the Agent Space — which should
 * never be a side effect of touching the pipeline.
 *
 * Each skill ships as one deterministic zip. The resource also takes a `Files` list, which
 * looks tidier in a template, but a multi-entry list silently creates only one file — a deploy
 * of this very skill produced an asset missing its reference document. The zip is expanded by
 * the service, which was verified to create every file.
 */
export class CustomSkillsStack extends Stack {
  readonly skills: readonly SkillDefinition[];

  constructor(scope: Construct, id: string, props: CustomSkillsStackProps) {
    super(scope, id, props);

    if (!props.agentSpaceId?.trim()) {
      throw new Error('agentSpaceId is required: skills are created inside an existing Agent Space');
    }

    const skillsRoot = props.skillsRoot ?? path.join(__dirname, '..', '..', 'skills');
    // Agent types are declared per skill, in SKILL.md under metadata.agent_types.
    this.skills = readSkills(skillsRoot, props.active !== undefined ? { active: props.active } : {});

    if (this.skills.length === 0) {
      Annotations.of(this).addWarning(
        `No skills found under ${skillsRoot}. Add a directory containing a SKILL.md, or leave ` +
          'enableCustomSkills unset.',
      );
    }

    /**
     * Construct ids already used, so a collision is reported against the skills that caused it.
     * Two names can reduce to one id, because uppercasing a digit does nothing: `rds-1` and `rds1`
     * both become `Rds1`, and CDK strips the hyphen out of a logical id anyway. Left alone, CDK
     * fails with a duplicate-construct error that names neither skill.
     */
    const constructIds = new Map<string, string>();

    for (const skill of this.skills) {
      for (const warning of skill.warnings) {
        Annotations.of(this).addWarning(warning);
      }

      const constructId = `Skill${toConstructId(skill.name)}`;
      const clash = constructIds.get(constructId);
      if (clash) {
        throw new Error(
          `Skills ${clash} and ${skill.name} both map to the construct id ${constructId}. ` +
            'Rename one of them: a hyphen before a digit disappears from a CloudFormation logical ' +
            'id, so the two cannot be told apart.',
        );
      }
      constructIds.set(constructId, skill.name);

      // Construct id keyed on the skill name, so adding a skill never disturbs another.
      const asset = new devopsagent.CfnAsset(this, constructId, {
        agentSpaceId: props.agentSpaceId,
        assetType: 'skill',
        // Only what the zip path honours. The service reads name and description from the
        // SKILL.md frontmatter and ignores them here, so sending them too would let two copies
        // disagree. Keys are snake_case, unlike the resource's own camelCase properties.
        metadata: {
          agent_types: [...skill.agentTypes],
          status: skill.active ? 'ACTIVE' : 'INACTIVE',
        },
        zip: buildSkillArchive(skill),
      });

      new CfnOutput(this, `${constructId}AssetId`, {
        value: asset.attrAssetId,
        description: `Asset id of the ${skill.name} skill`,
      });
    }
  }
}

/** `alarm-bridge-triage` becomes `AlarmBridgeTriage`, which is a valid construct id. */
function toConstructId(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
