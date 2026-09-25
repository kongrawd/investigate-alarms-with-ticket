/**
 * Silences the audit logger during unit tests.
 *
 * Powertools writes real JSON to stdout, which buries test output and the coverage table.
 * Tests that assert on audit records spy on the logger's methods, and a spy replaces the
 * method before Powertools checks the level, so silencing here costs no coverage.
 *
 * Runs in setupFiles, not setupFilesAfterEach, because the level is read when the Logger is
 * constructed at module load.
 */
process.env['POWERTOOLS_LOG_LEVEL'] = 'SILENT';
