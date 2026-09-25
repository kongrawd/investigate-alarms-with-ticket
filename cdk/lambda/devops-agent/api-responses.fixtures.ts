import type { Asset, Task } from '@aws-sdk/client-devops-agent';

/**
 * Complete DevOps Agent response objects for mocked calls. The SDK response types require
 * every field, so building them here keeps the tests readable and means a field added by
 * a future SDK version is fixed in one place.
 */

export function taskResponse(overrides: Partial<Task> = {}): Task {
  return {
    agentSpaceId: 'a1b2c3d4-5678-90ab-cdef-EXAMPLE11111',
    taskId: 'task-123',
    executionId: 'exec-123',
    title: 'CloudWatch Alarm: checkout-5xx-rate',
    taskType: 'INVESTIGATION',
    priority: 'HIGH',
    status: 'PENDING_TRIAGE',
    createdAt: new Date('2026-09-25T04:12:10.000Z'),
    updatedAt: new Date('2026-09-25T04:12:10.000Z'),
    version: 1,
    ...overrides,
  };
}

export function assetResponse(overrides: Partial<Asset> = {}): Asset {
  return {
    assetId: 'ki-a1b2c3d4-5678-90ab-cdef-EXAMPLE22222',
    assetType: 'skill',
    metadata: { name: 'checkout-5xx-runbook', agent_types: ['GENERIC'] },
    version: 1,
    createdAt: new Date('2026-09-25T04:12:10.000Z'),
    updatedAt: new Date('2026-09-25T04:12:10.000Z'),
    ...overrides,
  };
}
