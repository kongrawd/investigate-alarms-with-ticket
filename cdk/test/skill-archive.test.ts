import {
  FIXED_MTIME,
  MAX_ARCHIVE_BASE64_BYTES,
  buildSkillArchive,
  readSkillArchive,
} from '../lib/skills/skill-archive';

/** Test files are written as text; the loader itself hands over bytes. */
const file = (path: string, text: string) => ({ path, content: new TextEncoder().encode(text) });
const textOf = (archive: Record<string, Uint8Array>, path: string) =>
  new TextDecoder().decode(archive[path]);

/**
 * The archive is inlined in the CloudFormation template, so two properties matter: the service
 * must be able to expand it into every file, and the bytes must depend only on content. fflate
 * owns the format; these cases cover the contract this stack depends on.
 */
const SKILL = { name: 'example', description: 'an example' };
/** Valid frontmatter plus a body of the requested size, since the archive now verifies it. */
const skillMd = (body: string): string =>
  `---\nname: ${SKILL.name}\ndescription: ${SKILL.description}\n---\n\n${body}`;

const FILES = [
  file('SKILL.md', `---\nname: ${SKILL.name}\ndescription: ${SKILL.description}\n---\n\n# one\n`),
  file('references/two.md', '# two\n'),
];

describe('buildSkillArchive', () => {
  it('packs every file, which is what the Files list failed to do', () => {
    const archive = readSkillArchive(buildSkillArchive({ ...SKILL, files: FILES }));

    expect(Object.keys(archive).sort()).toEqual(['SKILL.md', 'references/two.md']);
    expect(textOf(archive, 'references/two.md')).toBe('# two\n');
  });

  it('packs bytes unchanged, so an image survives the round trip', () => {
    // Read as UTF-8 text these bytes become U+FFFD and the file arrives unreadable.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
    const files = [FILES[0]!, { path: 'assets/diagram.png', content: png }];

    expect(readSkillArchive(buildSkillArchive({ ...SKILL, files }))['assets/diagram.png']).toEqual(png);
  });

  it('produces the same bytes every time, so a synth does not churn the template', () => {
    expect(buildSkillArchive({ ...SKILL, files: FILES })).toBe(buildSkillArchive({ ...SKILL, files: FILES }));
  });

  it('produces the same bytes from a different process, since nothing ambient is recorded', () => {
    // A timestamp or a path would make this fail when the archive is rebuilt later.
    expect(buildSkillArchive({ ...SKILL, files: FILES })).toBe(
      buildSkillArchive({ ...SKILL, files: FILES.map((entry) => ({ ...entry })) }),
    );
  });

  it('changes when any content changes', () => {
    const edited = [FILES[0]!, file('references/two.md', '# three\n')];

    expect(buildSkillArchive({ ...SKILL, files: edited })).not.toBe(buildSkillArchive({ ...SKILL, files: FILES }));
  });

  it('stores rather than compresses, so the bytes do not depend on a compressor version', () => {
    const body = 'a'.repeat(4096);
    const archive = Buffer.from(buildSkillArchive({ ...SKILL, files: [file('SKILL.md', skillMd(body))] }), 'base64');

    // Stored entries cannot be smaller than their contents; a deflated one would be far smaller.
    expect(archive.length).toBeGreaterThan(body.length);
  });

  it('pins the archive date to a local calendar date inside the DOS range', () => {
    // A zip stores an MS-DOS date, which fflate derives from local calendar fields. Asserting the
    // local rendering is what makes this zone-independent: Date.UTC(1980, 0, 1) rendered as 1979
    // west of UTC, which fflate rejects outright, so every synth in the Americas failed while
    // passing here. Setting process.env.TZ inside a test cannot catch that — Node has already
    // cached the zone — so the invariant is asserted instead.
    const stamp = new Date(FIXED_MTIME);

    expect([stamp.getFullYear(), stamp.getMonth(), stamp.getDate(), stamp.getHours()]).toEqual([1985, 0, 1, 12]);
  });

  it('refuses a skill with no files', () => {
    expect(() => buildSkillArchive({ ...SKILL, files: [] })).toThrow(/no files to package/);
  });

  it('refuses an archive with no SKILL.md, which would create a nameless skill', () => {
    const files = [file('references/two.md', '# two\n')];

    expect(() => buildSkillArchive({ ...SKILL, files })).toThrow(/no SKILL.md/);
  });

  it('refuses an archive whose frontmatter disagrees with the validated values', () => {
    // Under a zip upload the packed frontmatter wins, so a stale copy would silently rename
    // the skill in the Agent Space.
    const files = [file('SKILL.md', '---\nname: other\ndescription: drifted\n---\n')];

    expect(() => buildSkillArchive({ ...SKILL, files })).toThrow(/frontmatter does not match/);
  });

  it('refuses an archive that would crowd the template budget', () => {
    // The limit exists because the template, not the property, is the real ceiling.
    const huge = [file('SKILL.md', skillMd('a'.repeat(MAX_ARCHIVE_BASE64_BYTES)))];

    expect(() => buildSkillArchive({ ...SKILL, files: huge })).toThrow(/over the 262144 this stack allows/);
  });
});
