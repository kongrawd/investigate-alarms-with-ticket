import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_TYPES, readSkill, readSkills, skillFileText } from '../lib/skills/skill-definition';

/**
 * The loader exists to fail at synth on anything DevOps Agent would reject at upload, so these
 * cases mirror the documented rules rather than the implementation.
 */
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DESCRIPTION =
  'Investigation procedure for the checkout service. Use this skill when an alarm names the ' +
  'checkout load balancer, when 5xx rates rise, or when latency exceeds its threshold.';

function writeSkill(
  name: string,
  { frontmatter = `name: ${name}\ndescription: ${DESCRIPTION}`, files = {} as Record<string, string> } = {},
): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`);

  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(directory, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return directory;
}

/** Bytes that are not valid UTF-8, so a text read would replace them with U+FFFD. */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);

describe('readSkill', () => {
  it('reads the name and description, and ships every file it finds', () => {
    const directory = writeSkill('checkout-triage', {
      files: { 'references/metrics.md': '# Metrics\n', 'assets/flow.txt': 'diagram\n' },
    });

    const skill = readSkill(directory);

    expect(skill.name).toBe('checkout-triage');
    expect(skill.description).toBe(DESCRIPTION);
    expect(skill.active).toBe(true);
    expect(skill.files.map((file) => file.path).sort()).toEqual([
      'SKILL.md',
      'assets/flow.txt',
      'references/metrics.md',
    ]);
    expect(skill.warnings).toEqual([]);
  });

  it('applies to every agent type unless the skill narrows it', () => {
    expect(readSkill(writeSkill('checkout-triage')).agentTypes).toEqual(['GENERIC']);
  });

  it.each([
    ['a bare value', 'INCIDENT_TRIAGE', ['INCIDENT_TRIAGE']],
    ['a comma list', 'INCIDENT_TRIAGE, INCIDENT_RCA', ['INCIDENT_TRIAGE', 'INCIDENT_RCA']],
    ['a bracketed list', '[INCIDENT_TRIAGE, INCIDENT_RCA]', ['INCIDENT_TRIAGE', 'INCIDENT_RCA']],
  ])('reads agent types from metadata as %s', (_form, declared, expected) => {
    const directory = writeSkill('checkout-triage', {
      frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  agent_types: ${declared}`,
    });

    expect(readSkill(directory).agentTypes).toEqual(expected);
  });

  it('reads a folded description, which is how the docs write a long one', () => {
    const directory = writeSkill('checkout-triage', {
      frontmatter:
        `name: checkout-triage\ndescription: >-\n  ${DESCRIPTION.slice(0, 49)}\n  ${DESCRIPTION.slice(50)}`,
    });

    expect(readSkill(directory).description).toBe(DESCRIPTION);
  });

  it('keeps a folded description whole when a line of it contains a colon', () => {
    // "Note: …" reads as a new field. Treating it as one truncated the description there and
    // invented a Note field, while the service, parsing real YAML, saw the whole value — so the
    // length limit and the short-description warning were both judged on the wrong text.
    const directory = writeSkill('checkout-triage', {
      frontmatter:
        'name: checkout-triage\ndescription: >-\n  First part of the description that is long ' +
        'enough to pass.\n  Note: a colon here.\n  Third part.',
    });

    expect(readSkill(directory).description).toBe(
      'First part of the description that is long enough to pass. Note: a colon here. Third part.',
    );
  });

  it('reads agent types written as a folded block', () => {
    // This parsed to an empty value and silently widened the skill to every agent type.
    const directory = writeSkill('checkout-triage', {
      frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  agent_types: >-\n    CHAT`,
    });

    expect(readSkill(directory).agentTypes).toEqual(['CHAT']);
  });

  it('ships binary files byte for byte, so an image stays readable', () => {
    const directory = writeSkill('checkout-triage');
    fs.mkdirSync(path.join(directory, 'assets'));
    fs.writeFileSync(path.join(directory, 'assets/diagram.png'), PNG_HEADER);

    const asset = readSkill(directory).files.find((entry) => entry.path === 'assets/diagram.png');

    expect(Buffer.from(asset!.content)).toEqual(PNG_HEADER);
  });

  it('decodes text files, which is what the markdown needs', () => {
    const files = { 'references/metrics.md': '# Metrics\n' };

    const reference = readSkill(writeSkill('checkout-triage', { files })).files.find(
      (entry) => entry.path === 'references/metrics.md',
    );

    expect(skillFileText(reference!)).toBe('# Metrics\n');
  });

  it('puts SKILL.md first even when another file sorts ahead of it', () => {
    // The entry point has to lead: a deploy that put a reference file first created the asset
    // with only one file.
    const files = { 'AGENTS.md': '# notes\n', 'references/metrics.md': '# Metrics\n' };

    expect(readSkill(writeSkill('checkout-triage', { files })).files.map((entry) => entry.path)).toEqual([
      'SKILL.md',
      'AGENTS.md',
      'references/metrics.md',
    ]);
  });

  it('reads frontmatter that has a blank line between its fields', () => {
    const directory = writeSkill('checkout-triage', {
      frontmatter: `name: checkout-triage\n\ndescription: ${DESCRIPTION}\n\nmetadata:\n  agent_types: CHAT`,
    });

    const skill = readSkill(directory);

    expect(skill.description).toBe(DESCRIPTION);
    expect(skill.agentTypes).toEqual(['CHAT']);
  });

  it('can be uploaded inactive, for review before the agent loads it', () => {
    expect(readSkill(writeSkill('checkout-triage'), { active: false }).active).toBe(false);
  });

  it('warns when the description is too short to trigger reliably', () => {
    const directory = writeSkill('checkout-triage', {
      frontmatter: 'name: checkout-triage\ndescription: Checkout skill',
    });

    expect(readSkill(directory).warnings).toEqual([expect.stringContaining('100 is recommended')]);
  });

  describe('rejects what upload would reject', () => {
    it('a missing SKILL.md', () => {
      const directory = path.join(root, 'checkout-triage');
      fs.mkdirSync(directory);

      expect(() => readSkill(directory)).toThrow(/SKILL.md is required/);
    });

    it('a missing frontmatter block', () => {
      const directory = path.join(root, 'checkout-triage');
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'SKILL.md'), '# No frontmatter\n');

      expect(() => readSkill(directory)).toThrow(/must open with a --- frontmatter block/);
    });

    it('a name that does not match the directory, which the specification requires', () => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: something-else\ndescription: ${DESCRIPTION}`,
      });

      expect(() => readSkill(directory)).toThrow(/match its directory/);
    });

    it.each(['Checkout-Triage', 'checkout_triage', '-checkout', 'checkout-', `${'a'.repeat(65)}`])(
      'an invalid name: %s',
      (name) => {
        const directory = writeSkill(name, { frontmatter: `name: ${name}\ndescription: ${DESCRIPTION}` });

        expect(() => readSkill(directory)).toThrow(/name must be lowercase|match its directory/);
      },
    );

    it('a missing description, which would stop the skill ever loading', () => {
      const directory = writeSkill('checkout-triage', { frontmatter: 'name: checkout-triage' });

      expect(() => readSkill(directory)).toThrow(/must declare a description/);
    });

    it('a frontmatter block with no name at all', () => {
      const directory = writeSkill('checkout-triage', { frontmatter: `description: ${DESCRIPTION}` });

      expect(() => readSkill(directory)).toThrow(/must declare a name/);
    });

    it.each(['name', 'description'])('%s declared under metadata, where the service ignores it', (field) => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  ${field}: shadowed`,
      });

      expect(() => readSkill(directory)).toThrow(new RegExp(`metadata.${field} is ignored`));
    });

    it('an agent_types field left empty, which would widen the skill to every type', () => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  agent_types:`,
      });

      expect(() => readSkill(directory)).toThrow(/present but empty/);
    });

    it('a description over the 1024 character limit', () => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: checkout-triage\ndescription: ${'a'.repeat(1025)}`,
      });

      expect(() => readSkill(directory)).toThrow(/at most 1024 characters/);
    });

    it('an agent type that does not exist', () => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  agent_types: TRIAGE`,
      });

      expect(() => readSkill(directory)).toThrow(/'TRIAGE' is not an agent type/);
    });

    it('GENERIC combined with another type, since it already covers them all', () => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  agent_types: GENERIC, CHAT`,
      });

      expect(() => readSkill(directory)).toThrow(/cannot be combined/);
    });

    it('an empty agent type list', () => {
      const directory = writeSkill('checkout-triage', {
        frontmatter: `name: checkout-triage\ndescription: ${DESCRIPTION}\nmetadata:\n  agent_types: []`,
      });

      expect(() => readSkill(directory)).toThrow(/is empty/);
    });

    it('a scripts directory, which upload refuses by name', () => {
      const directory = writeSkill('checkout-triage', { files: { 'scripts/collect.md': 'not allowed\n' } });

      expect(() => readSkill(directory)).toThrow(/scripts\/ directory is rejected at upload/);
    });
  });
});

describe('readSkills', () => {
  it('reads every skill directory in a stable order', () => {
    writeSkill('rds-triage');
    writeSkill('checkout-triage');

    expect(readSkills(root).map((skill) => skill.name)).toEqual(['checkout-triage', 'rds-triage']);
  });

  it('returns nothing when the directory is absent, rather than failing a synth', () => {
    expect(readSkills(path.join(root, 'absent'))).toEqual([]);
  });

  it('ignores loose files beside the skill directories', () => {
    writeSkill('checkout-triage');
    fs.writeFileSync(path.join(root, 'README.md'), '# Skills\n');

    expect(readSkills(root)).toHaveLength(1);
  });
});

describe('AGENT_TYPES', () => {
  it('matches the set the service accepts', () => {
    // Guards against a value drifting out of the union the metadata is validated against.
    expect([...AGENT_TYPES]).toEqual([
      'GENERIC',
      'CHAT',
      'INCIDENT_TRIAGE',
      'INCIDENT_RCA',
      'INCIDENT_MITIGATION',
      'INCIDENT_UI',
      'PREVENTION',
      'RELEASE_READINESS_REVIEW',
      'RELEASE_TESTING',
    ]);
  });
});
