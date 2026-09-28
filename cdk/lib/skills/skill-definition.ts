import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Reads skills from `skills/<skill-name>/` and checks them against the rules DevOps Agent
 * enforces, so a malformed skill fails at synth rather than at upload.
 *
 * Layout is flat, one directory per skill, matching the Agent Skills specification and the
 * shape the console exports. Agent types are declared inside SKILL.md under the
 * specification's `metadata` map, which is its designated place for properties the
 * specification itself does not define:
 *
 *   metadata:
 *     agent_types: INCIDENT_TRIAGE, INCIDENT_RCA
 *
 * A skill that declares nothing applies to every agent type. Note that only this stack reads
 * that field — the console asks for agent types in its own dropdown, because it reads just
 * `name` and `description` from frontmatter.
 *
 * Rules checked here:
 *
 *  - SKILL.md is mandatory and must carry `name` and `description` in frontmatter
 *  - name: lowercase letters, numbers and single hyphens, 1-64 characters, and identical to
 *    the skill's own directory name, as the specification requires
 *  - description: 1-1024 characters, with 100 recommended as the point below which the agent
 *    struggles to decide whether the skill applies
 *  - agent types must be real, and GENERIC cannot be combined with others
 *  - a scripts/ directory is rejected by name, as upload does
 *
 * A skill may add references/ and assets/ directories; every file found is shipped. Optional
 * specification fields such as license or compatibility are left untouched.
 */

/** Agent types a skill can be scoped to. GENERIC means every type. */
export const AGENT_TYPES = [
  'GENERIC',
  'CHAT',
  'INCIDENT_TRIAGE',
  'INCIDENT_RCA',
  'INCIDENT_MITIGATION',
  'INCIDENT_UI',
  'PREVENTION',
  'RELEASE_READINESS_REVIEW',
  'RELEASE_TESTING',
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export interface SkillFile {
  /** Path within the asset bundle, e.g. `SKILL.md` or `references/metrics.md`. */
  readonly path: string;
  /**
   * Raw bytes, not text. Skills may carry images and data files alongside their markdown, and
   * decoding those as UTF-8 replaces every byte outside the encoding with U+FFFD — a diagram
   * that uploads without error and arrives unreadable.
   */
  readonly content: Uint8Array;
}

/** Decodes a text file's bytes, for the markdown a skill is mostly made of. */
export function skillFileText(file: SkillFile): string {
  return new TextDecoder().decode(file.content);
}

export interface SkillDefinition {
  readonly directory: string;
  readonly name: string;
  readonly description: string;
  readonly agentTypes: readonly AgentType[];
  /** Inactive skills stay in the Agent Space but the agent does not load them. */
  readonly active: boolean;
  readonly files: readonly SkillFile[];
  /** Advisory messages, surfaced as CDK warnings rather than failures. */
  readonly warnings: readonly string[];
}

/** Lowercase alphanumerics and single hyphens, no leading, trailing or doubled hyphen. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const RECOMMENDED_DESCRIPTION_LENGTH = 100;

export interface ReadSkillOptions {
  readonly active?: boolean;
}

export function readSkill(directory: string, options: ReadSkillOptions = {}): SkillDefinition {
  const name = path.basename(directory);
  const skillPath = path.join(directory, 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill ${name}: SKILL.md is required at ${skillPath}`);
  }

  const { fields, metadata } = parseFrontmatter(fs.readFileSync(skillPath, 'utf8'), name);
  const warnings: string[] = [];

  const declaredName = fields['name'];
  if (!declaredName) {
    throw new Error(`Skill ${name}: frontmatter must declare a name`);
  }
  if (declaredName !== name) {
    throw new Error(
      `Skill ${name}: frontmatter name is '${declaredName}'. The specification requires the name ` +
        'to match its directory, so keep them identical.',
    );
  }
  if (declaredName.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(declaredName)) {
    throw new Error(
      `Skill ${name}: name must be lowercase letters, numbers and single hyphens, ` +
        `1-${MAX_NAME_LENGTH} characters, and must not start or end with a hyphen`,
    );
  }

  for (const shadowed of ['name', 'description']) {
    if (metadata[shadowed] !== undefined) {
      throw new Error(
        `Skill ${name}: metadata.${shadowed} is ignored. Declare ${shadowed} at the top level of ` +
          'the frontmatter, which is where the service reads it from for a zip upload.',
      );
    }
  }

  const description = fields['description'];
  if (!description) {
    throw new Error(
      `Skill ${name}: frontmatter must declare a description. The agent reads it to decide ` +
        'whether the skill applies, so a missing one means the skill never loads.',
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Skill ${name}: description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (description.length < RECOMMENDED_DESCRIPTION_LENGTH) {
    warnings.push(
      `Skill ${name}: description is ${description.length} characters. At least ` +
        `${RECOMMENDED_DESCRIPTION_LENGTH} is recommended — name the scenarios, services and ` +
        'symptoms that should trigger it, or the agent may skip the skill entirely.',
    );
  }

  return {
    directory,
    name: declaredName,
    description,
    agentTypes: readAgentTypes(metadata['agent_types'], name),
    active: options.active ?? true,
    files: readFiles(directory, name),
    warnings,
  };
}

/** Every skill directory under `root`, in a stable order. */
export function readSkills(root: string, options: ReadSkillOptions = {}): SkillDefinition[] {
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readSkill(path.join(root, name), options));
}

/** Accepts `GENERIC`, `A, B` or `[A, B]`; absent means every agent type. */
function readAgentTypes(declared: string | undefined, skillName: string): readonly AgentType[] {
  // Absent means every type. Present but empty is a mistake, and defaulting it to GENERIC would
  // widen a skill the author meant to narrow, so it fails instead.
  if (declared === undefined) return ['GENERIC'];
  if (declared.trim() === '') {
    throw new Error(
      `Skill ${skillName}: metadata.agent_types is present but empty, which would apply the ` +
        'skill to every agent type. Name the types, or remove the field to mean every type.',
    );
  }

  const values = declared
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const value of values) {
    if (!isAgentType(value)) {
      throw new Error(
        `Skill ${skillName}: '${value}' is not an agent type. Expected one of: ` +
          `${AGENT_TYPES.join(', ')}.`,
      );
    }
  }
  if (values.length === 0) {
    throw new Error(`Skill ${skillName}: metadata.agent_types is empty. Omit it to mean every type.`);
  }
  if (values.includes('GENERIC') && values.length > 1) {
    throw new Error(
      `Skill ${skillName}: GENERIC already covers every agent type, so it cannot be combined ` +
        'with others.',
    );
  }

  return values as AgentType[];
}

function isAgentType(value: string): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value);
}

function readFiles(directory: string, skillName: string): SkillFile[] {
  const files: SkillFile[] = [];

  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name));

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'scripts') {
          throw new Error(
            `Skill ${skillName}: a scripts/ directory is rejected at upload. Skills carry ` +
              'instructions and reference material only.',
          );
        }
        walk(absolute);
        continue;
      }

      files.push({
        // Always POSIX separators: this is a key inside the asset bundle, not a local path.
        path: path.relative(directory, absolute).split(path.sep).join('/'),
        content: fs.readFileSync(absolute),
      });
    }
  };

  walk(directory);

  // SKILL.md first, then the rest by code unit. The entry point leading is the order the
  // service's own documented example uses, and a deploy that put a reference file first
  // created the asset with only one file.
  return files.sort((a, b) => {
    if (a.path === 'SKILL.md') return -1;
    if (b.path === 'SKILL.md') return 1;
    return byCodeUnit(a.path, b.path);
  });
}

/**
 * Orders by code unit rather than `localeCompare`, because this order becomes the order of
 * entries in the archive. `localeCompare` follows the runtime's collation, so the same skill
 * would pack differently under a different ICU locale and rewrite the asset for nothing.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : 1;
}

interface Frontmatter {
  readonly fields: Record<string, string>;
  readonly metadata: Record<string, string>;
}

/**
 * Reads the documented frontmatter shape: `key: value` pairs between `---` fences, folded
 * values continuing on indented lines, and a one-level `metadata:` map. Narrow enough that a
 * YAML dependency in the infrastructure closure is not worth it.
 */
/** Top-level frontmatter fields only, for verifying what an archive actually ships. */
export function readFrontmatterFields(source: string, skillName: string): Record<string, string> {
  return parseFrontmatter(source, skillName).fields;
}

function parseFrontmatter(source: string, skillName: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match?.[1]) {
    throw new Error(`Skill ${skillName}: SKILL.md must open with a --- frontmatter block`);
  }

  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  /** The field a folded value is still accumulating into, and the map it belongs to. */
  let pending: { readonly map: Record<string, string>; readonly key: string } | undefined;
  /** Indentation of `metadata:`'s own entries, learned from the first one. */
  let metadataIndent: number | undefined;
  let inMetadata = false;

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());

    // Indentation decides first, and only then the key: value shape. A folded description
    // continuing with "Note: something" reads as a pair, and treating it as one truncated the
    // description at that line and invented a `Note` field — while the service, parsing real
    // YAML, saw the whole value.
    const startsField = indent === 0 || (inMetadata && pair && indent === (metadataIndent ?? indent));

    if (pair && startsField) {
      const name = pair[1]!;
      // `>-` or `|` introduces a folded block whose value starts on the next line.
      const value = pair[2]!.replace(/^[>|][-+]?$/, '').trim();

      if (indent === 0) {
        inMetadata = name === 'metadata';
        metadataIndent = undefined;
        if (inMetadata) {
          pending = undefined;
          continue;
        }
        fields[name] = value;
        pending = { map: fields, key: name };
        continue;
      }

      metadataIndent = indent;
      metadata[name] = value;
      pending = { map: metadata, key: name };
      continue;
    }

    // Anything else indented belongs to the field above it, whether that is a top-level
    // description or a metadata entry written as a folded block.
    if (pending && indent > 0) {
      pending.map[pending.key] = `${pending.map[pending.key]} ${line.trim()}`.trim();
    }
  }

  return { fields, metadata };
}
