/**
 * The bridge's configuration surface, as a closed set of names.
 *
 * Every read goes through here, which keeps three things true: a typo in a variable name is a
 * compile error rather than a silent `undefined`; `noPropertyAccessFromIndexSignature` has one
 * place to be satisfied instead of a bracket at every call site; and the full set of
 * configuration the function depends on is greppable in one file.
 */
const ENV_KEYS = [
  'DELIVERY_MODE',
  'WEBHOOK_SECRET_ARN',
  'AGENT_SPACE_ID',
  'DEVOPS_AGENT_REGION',
  'AWS_REGION',
  'POWERTOOLS_SERVICE_NAME',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

/** Reads a variable, treating blank as absent so `-c foo=` cannot produce an empty config. */
export function env(key: EnvKey): string | undefined {
  const value = process.env[key];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** Reads a variable the function cannot run without, failing loudly and by name. */
export function requireEnv(key: EnvKey): string {
  const value = env(key);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}
