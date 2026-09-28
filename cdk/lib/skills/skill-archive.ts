import { unzipSync, zipSync } from 'fflate';
import { readFrontmatterFields, type SkillDefinition } from './skill-definition';

/**
 * Packs a skill's files into the base64 zip that `AWS::DevOpsAgent::Asset` accepts.
 *
 * A zip rather than the resource's `Files` list, because a multi-entry `Files` list silently
 * creates only one file: deploying a skill with SKILL.md plus one reference document produced
 * an asset holding SKILL.md alone, in either ordering. A zip is one payload that the service
 * expands itself, which was verified to create every file — and it lets the frontmatter be the
 * single source of truth for the name and description, since the service reads them from
 * SKILL.md and ignores whatever metadata claims.
 *
 * fflate does the packing. It is the rare zip library with a synchronous API, which a CDK
 * construct needs: JSZip only generates asynchronously, and CDK's own zipping happens later, in
 * the CLI's asset-publishing step, so no archive exists at synth time to reuse.
 */

/**
 * Fixed timestamp, so the bytes depend only on content. The archive is inlined in the
 * CloudFormation template; with real file times every synth would emit a different payload and
 * every deploy would rewrite the asset for nothing.
 *
 * Built from local date components on purpose. A zip stores an MS-DOS date, which fflate derives
 * from the local calendar fields of whatever it is given, so `Date.UTC(1980, 0, 1)` reads as 1979
 * anywhere west of UTC and fflate rejects it outright with "date not in range 1980-2099" — every
 * synth failing for developers and CI runners in the Americas. Constructing from local fields
 * makes all zones render the same calendar values, which is what keeps the bytes identical. Noon
 * mid-winter, to stay clear of any zone whose clocks move near midnight.
 */
export const FIXED_MTIME = new Date(1985, 0, 1, 12, 0, 0).getTime();

/**
 * Stored, not deflated. Deflate output can differ between builds of a compressor, and skill
 * content is markdown measured in kilobytes, so compression buys nothing and costs determinism.
 */
const STORE = 0;

/**
 * The practical ceiling is the CloudFormation template, not the resource's 8 MiB property
 * limit. A template stored in S3 — which is what the CDK does — may reach 1 MB, and this
 * archive competes with the rest of the stack for it. Refusing at a quarter leaves headroom and
 * still allows far more prose than a skill should carry.
 */
export const MAX_ARCHIVE_BASE64_BYTES = 262_144;

export function buildSkillArchive(skill: Pick<SkillDefinition, 'name' | 'description' | 'files'>): string {
  const { name: skillName, description, files } = skill;

  if (files.length === 0) {
    throw new Error(`Skill ${skillName}: no files to package`);
  }

  const contents: Record<string, [Uint8Array, { level: 0; mtime: number }]> = {};
  for (const file of files) {
    contents[file.path] = [file.content, { level: STORE, mtime: FIXED_MTIME }];
  }

  // The zip path makes the packed frontmatter authoritative: the service reads the name and
  // description from it and ignores the metadata we send. So the archive is checked to carry the
  // frontmatter that was validated. Without this, an archive missing SKILL.md — or carrying a
  // stale copy — would create a nameless skill and report success.
  const packed = contents['SKILL.md'];
  if (!packed) {
    throw new Error(
      `Skill ${skillName}: the archive has no SKILL.md, so the service would have no frontmatter ` +
        'to read the name and description from',
    );
  }
  const shipped = readFrontmatterFields(new TextDecoder().decode(packed[0]), skillName);
  if (shipped['name'] !== skillName || shipped['description'] !== description) {
    throw new Error(
      `Skill ${skillName}: the packaged SKILL.md frontmatter does not match the validated ` +
        `values. It declares name '${shipped['name']}' and a description of ` +
        `${(shipped['description'] ?? '').length} characters. Under a zip upload the frontmatter ` +
        'wins, so these must agree.',
    );
  }

  const base64 = Buffer.from(zipSync(contents, { level: STORE, mtime: FIXED_MTIME })).toString('base64');

  if (base64.length > MAX_ARCHIVE_BASE64_BYTES) {
    throw new Error(
      `Skill ${skillName}: packaged size is ${base64.length} base64 bytes, over the ` +
        `${MAX_ARCHIVE_BASE64_BYTES} this stack allows. The archive is inlined in the ` +
        'CloudFormation template, so it competes with the 1 MB template budget. Trim the ' +
        'reference material, or move to an S3-backed custom resource.',
    );
  }

  return base64;
}

/**
 * Reads an archive back, for tests and for verifying what a deploy would send. Bytes rather than
 * text, so a corrupted image is visible rather than decoded away.
 */
export function readSkillArchive(base64: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(Buffer.from(base64, 'base64')));
}
