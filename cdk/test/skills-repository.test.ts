import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSkillArchive, readSkillArchive } from '../lib/skills/skill-archive';
import { AGENT_TYPES, readSkills, skillFileText, type SkillDefinition } from '../lib/skills/skill-definition';

/**
 * Checks the skills this repository actually ships, rather than fixtures.
 *
 * The loader's own tests cover the rules; these cover the content. Everything asserted here is
 * something we control and can regress silently: a frontmatter edit that drops an agent type, a
 * reference document that stops being packaged, a description trimmed below the length the agent
 * needs to match on. None of it depends on what the agent chooses to do at runtime.
 */
const SKILLS_ROOT = path.join(__dirname, '..', '..', 'skills');
const skills = readSkills(SKILLS_ROOT);

/** Named so a missing skill fails as a missing test rather than an undefined lookup. */
const skillNamed = (name: string): SkillDefinition => {
  const found = skills.find((skill) => skill.name === name);
  if (!found) throw new Error(`No skill named ${name} under ${SKILLS_ROOT}`);
  return found;
};

describe('the skills this repository ships', () => {
  it('has at least one, since an empty directory deploys an empty stack', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it('loads every skill directory without a warning', () => {
    expect(skills.flatMap((skill) => skill.warnings)).toEqual([]);
  });

  describe.each(skills.map((skill) => [skill.name, skill] as const))('%s', (_name, skill) => {
    it('declares agent types the service accepts', () => {
      expect(skill.agentTypes.length).toBeGreaterThan(0);
      expect(AGENT_TYPES).toEqual(expect.arrayContaining([...skill.agentTypes]));
    });

    it('packages every file that is on disk', () => {
      const onDisk = walk(skill.directory).sort();

      expect(Object.keys(readSkillArchive(buildSkillArchive(skill))).sort()).toEqual(onDisk);
    });

    it('points only at reference files it ships', () => {
      // A skill that names a missing document sends the agent to a dead end mid-incident.
      const entry = skill.files.find((file) => file.path === 'SKILL.md')!;
      const shipped = new Set(skill.files.map((file) => file.path));
      const referenced = [...skillFileText(entry).matchAll(/`((?:references|assets)\/[^`]+)`/g)].map(
        (match) => match[1]!,
      );

      expect(referenced.length).toBeGreaterThan(0);
      expect(referenced.filter((target) => !shipped.has(target))).toEqual([]);
    });
  });
});

describe('production-critical-support-case', () => {
  const skill = skillNamed('production-critical-support-case');

  it('is scoped to the agents that triage, diagnose and act on an incident', () => {
    // Escalation spans all three: triage classifies, RCA produces the findings, mitigation acts.
    expect([...skill.agentTypes]).toEqual(['INCIDENT_TRIAGE', 'INCIDENT_RCA', 'INCIDENT_MITIGATION']);
  });

  it('describes the situations it is for, which is what the agent matches on', () => {
    // The description is the only thing the agent sees before deciding to load the skill.
    for (const phrase of ['Support case', 'production-critical', 'findings']) {
      expect(skill.description).toContain(phrase);
    }
  });

  it('carries the two references its procedure sends the agent to', () => {
    expect(skill.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/production-signals.md',
      'references/support-case-fields.md',
    ]);
  });
});

describe('alarm-bridge-triage', () => {
  const skill = skillNamed('alarm-bridge-triage');

  it('is scoped to triage, where a delivery fault has to be ruled out first', () => {
    expect([...skill.agentTypes]).toEqual(['INCIDENT_TRIAGE']);
  });
});

/** Every file under a directory, as POSIX-separated paths relative to it. */
function walk(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}
