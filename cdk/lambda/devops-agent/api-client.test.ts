import {
  CreateAssetCommand,
  CreateBacklogTaskCommand,
  DevOpsAgentClient,
} from '@aws-sdk/client-devops-agent';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { createRunbookSkill, startInvestigation } from './api-client';
import { assetResponse, taskResponse } from './api-responses.fixtures';

const devOpsAgentMock = mockClient(DevOpsAgentClient);
const AGENT_SPACE_ID = 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111';

beforeEach(() => {
  devOpsAgentMock.reset();
});

describe('startInvestigation', () => {
  it('creates an INVESTIGATION task and returns its id', async () => {
    devOpsAgentMock.on(CreateBacklogTaskCommand).resolves({ task: taskResponse() });

    const taskId = await startInvestigation({
      agentSpaceId: AGENT_SPACE_ID,
      title: 'CloudWatch Alarm: checkout-5xx-rate',
      description: 'State reason: threshold crossed',
      priority: 'HIGH',
      clientToken: 'token-1',
    });

    expect(taskId).toBe('task-123');
    expect(devOpsAgentMock).toHaveReceivedCommandWith(CreateBacklogTaskCommand, {
      agentSpaceId: AGENT_SPACE_ID,
      taskType: 'INVESTIGATION',
      title: 'CloudWatch Alarm: checkout-5xx-rate',
      description: 'State reason: threshold crossed',
      priority: 'HIGH',
      clientToken: 'token-1',
    });
  });

  it('clamps title and description to the documented API limits', async () => {
    devOpsAgentMock.on(CreateBacklogTaskCommand).resolves({ task: taskResponse() });

    await startInvestigation({
      agentSpaceId: AGENT_SPACE_ID,
      title: 'a'.repeat(600),
      description: 'b'.repeat(20_000),
      priority: 'CRITICAL',
    });

    const input = devOpsAgentMock.commandCalls(CreateBacklogTaskCommand)[0]!.args[0].input;
    expect(input.title).toHaveLength(400);
    expect(input.description).toHaveLength(10_000);
  });

  it('passes a ticket reference through when one is supplied', async () => {
    devOpsAgentMock.on(CreateBacklogTaskCommand).resolves({ task: taskResponse() });
    // Every field is required by the API, and associationId must be a real association in
    // the Agent Space — a free-form ticket URL alone is not accepted.
    const reference = {
      system: 'servicenow',
      referenceId: 'INC0012345',
      referenceUrl: 'https://example.service-now.com/INC0012345',
      associationId: 'b1c2d3e4-5678-90ab-cdef-EXAMPLE33333',
      title: 'Checkout errors',
    };

    await startInvestigation({
      agentSpaceId: AGENT_SPACE_ID,
      title: 'Checkout errors',
      priority: 'HIGH',
      reference,
    });

    expect(devOpsAgentMock).toHaveReceivedCommandWith(CreateBacklogTaskCommand, { reference });
  });

  it('surfaces throttling so the caller can back off instead of dropping the alarm', async () => {
    devOpsAgentMock.on(CreateBacklogTaskCommand).rejects(new Error('ThrottlingException'));

    await expect(
      startInvestigation({ agentSpaceId: AGENT_SPACE_ID, title: 't', priority: 'LOW' }),
    ).rejects.toThrow('ThrottlingException');
  });
});

describe('createRunbookSkill', () => {
  it('publishes a runbook as a skill asset with a single SKILL.md file', async () => {
    devOpsAgentMock.on(CreateAssetCommand).resolves({ asset: assetResponse({ assetId: 'ki-abc' }) });

    const assetId = await createRunbookSkill({
      agentSpaceId: AGENT_SPACE_ID,
      name: 'checkout-5xx-runbook',
      description: 'Steps to triage checkout 5xx alarms.',
      markdown: '# Checkout 5xx\n\nCheck the ALB target group first.',
    });

    expect(assetId).toBe('ki-abc');
    expect(devOpsAgentMock).toHaveReceivedCommandWith(CreateAssetCommand, {
      agentSpaceId: AGENT_SPACE_ID,
      assetType: 'skill',
      content: {
        file: { path: 'SKILL.md', body: { text: '# Checkout 5xx\n\nCheck the ALB target group first.' } },
      },
    });
  });

  it('uses snake_case metadata keys and defaults agent_types to GENERIC', async () => {
    devOpsAgentMock.on(CreateAssetCommand).resolves({ asset: assetResponse({ assetId: 'ki-abc' }) });

    await createRunbookSkill({
      agentSpaceId: AGENT_SPACE_ID,
      name: 'checkout-5xx-runbook',
      description: 'Steps to triage checkout 5xx alarms.',
      markdown: '# Checkout 5xx',
    });

    // metadata keys are snake_case while the request's own keys are camelCase; the
    // service rejects the request if agent_types is absent or empty.
    expect(devOpsAgentMock.commandCalls(CreateAssetCommand)[0]!.args[0].input.metadata).toEqual({
      name: 'checkout-5xx-runbook',
      description: 'Steps to triage checkout 5xx alarms.',
      agent_types: ['GENERIC'],
    });
  });

  it('honours explicit agent types', async () => {
    devOpsAgentMock.on(CreateAssetCommand).resolves({ asset: assetResponse({ assetId: 'ki-abc' }) });

    await createRunbookSkill({
      agentSpaceId: AGENT_SPACE_ID,
      name: 'triage-runbook',
      description: 'Triage only.',
      markdown: '# Triage',
      agentTypes: ['INCIDENT_TRIAGE', 'INCIDENT_RCA'],
    });

    expect(devOpsAgentMock.commandCalls(CreateAssetCommand)[0]!.args[0].input.metadata).toMatchObject({
      agent_types: ['INCIDENT_TRIAGE', 'INCIDENT_RCA'],
    });
  });
});
