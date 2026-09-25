import {
  CreateAssetCommand,
  CreateBacklogTaskCommand,
  DevOpsAgentClient,
  type ReferenceInput,
} from '@aws-sdk/client-devops-agent';
import { env } from './env';
import type { IncidentPriority } from './webhook-client';

/**
 * SigV4 path into DevOps Agent, as an alternative to the HMAC webhook. No shared secret
 * and no rotation story — the Lambda execution role is the credential.
 *
 * Bundling note for when this is wired up in CDK: NodejsFunction externalizes
 * `@aws-sdk/*` by default on the assumption the runtime provides it, but the Lambda
 * runtime's bundled SDK does NOT include client-devops-agent. The function must bundle
 * it explicitly (drop '@aws-sdk/client-devops-agent' from `bundling.externalModules`),
 * or calls will fail at import time.
 *
 * IAM: `aidevops:CreateBacklogTask` / `aidevops:CreateAsset` on
 * `arn:aws:aidevops:<region>:<account>:agentspace/<agentSpaceId>`. Note the resource
 * segment is `agentspace/` — some published samples use `agent-space/`, which does not
 * match the service authorization reference.
 */
// The Agent Space is regional and need not match the Lambda's own Region. Spread rather than
// assigned, so an absent value leaves the SDK to its own resolution chain instead of pinning
// `region: undefined`.
const region = env('DEVOPS_AGENT_REGION') ?? env('AWS_REGION');
const client = new DevOpsAgentClient(region ? { region } : {});

export interface StartInvestigationInput {
  readonly agentSpaceId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly priority: IncidentPriority;
  /**
   * Links the investigation to the originating ticket. Every field including
   * `associationId` is required by the API, and `associationId` must be a real
   * association in the Agent Space (e.g. the ServiceNow integration) — you cannot attach
   * a free-form ticket URL without one.
   */
  readonly reference?: ReferenceInput | undefined;
  /** Idempotency token; reuse the alarm ARN + state change time to collapse retries. */
  readonly clientToken?: string | undefined;
}

/** Creates an INVESTIGATION backlog task, which starts an autonomous investigation. */
export async function startInvestigation(input: StartInvestigationInput): Promise<string | undefined> {
  const response = await client.send(
    new CreateBacklogTaskCommand({
      agentSpaceId: input.agentSpaceId,
      taskType: 'INVESTIGATION',
      title: input.title.slice(0, 400),
      description: input.description?.slice(0, 10_000),
      priority: input.priority,
      reference: input.reference,
      clientToken: input.clientToken,
    }),
  );
  return response.task?.taskId;
}

export interface RunbookSkillInput {
  readonly agentSpaceId: string;
  /** Lowercase letters, numbers and hyphens only, 1-64 chars, no leading/trailing hyphen. */
  readonly name: string;
  /** 1-1024 chars describing when the agent should load this runbook. */
  readonly description: string;
  readonly markdown: string;
  /** `['GENERIC']` makes it available to every agent type. */
  readonly agentTypes?: readonly string[] | undefined;
  readonly clientToken?: string | undefined;
}

/**
 * Publishes a runbook into the Agent Space.
 *
 * DevOps Agent has no `runbook` resource — procedures live as a `skill` asset that the
 * agent loads when the description matches the situation. (A runbook PDF would be an
 * `attachment`; standing operational context would be a `memory_store` plus `memory`
 * assets.) Note that `metadata` keys are snake_case while the request's own keys are
 * camelCase, and that UpdateAsset applies PATCH semantics to metadata.
 */
export async function createRunbookSkill(input: RunbookSkillInput): Promise<string | undefined> {
  const response = await client.send(
    new CreateAssetCommand({
      agentSpaceId: input.agentSpaceId,
      assetType: 'skill',
      metadata: {
        name: input.name,
        description: input.description,
        agent_types: [...(input.agentTypes ?? ['GENERIC'])],
      },
      content: {
        file: {
          path: 'SKILL.md',
          body: { text: input.markdown },
        },
      },
      clientToken: input.clientToken,
    }),
  );
  return response.asset?.assetId;
}
