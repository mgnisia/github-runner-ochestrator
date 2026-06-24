// Parsing + matching for GitHub `workflow_job` webhook events. No side effects, so these are
// unit-testable without webhook.ts's init-time SSM behaviour.

export interface WorkflowJob {
  id: number;
  run_id: number;
  labels: string[];
  name?: string;
  status?: string;
}

export interface WorkflowJobEvent {
  action?: string;
  workflow_job?: WorkflowJob;
  organization?: { login: string };
  repository?: { name: string; full_name: string; owner: { login: string } };
}

export interface MatchResult {
  matched: boolean;
  reason: string;
}

export function parseWorkflowJobEvent(rawBody: string): WorkflowJobEvent {
  return JSON.parse(rawBody) as WorkflowJobEvent;
}

/** Match only `queued` workflow_job events whose labels include `requiredLabel`. */
export function matchesRunnerRequest(event: WorkflowJobEvent, requiredLabel: string): MatchResult {
  if (event.action !== 'queued') {
    return { matched: false, reason: `action '${event.action ?? '(none)'}' is not 'queued'` };
  }
  const labels = event.workflow_job?.labels ?? [];
  if (!labels.includes(requiredLabel)) {
    return {
      matched: false,
      reason: `labels [${labels.join(', ')}] do not include required label '${requiredLabel}'`
    };
  }
  return { matched: true, reason: `queued job requests '${requiredLabel}'` };
}
