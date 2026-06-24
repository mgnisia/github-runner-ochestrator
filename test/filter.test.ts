import { matchesRunnerRequest, parseWorkflowJobEvent } from '../src/filter';

const queuedEvent = {
  action: 'queued',
  workflow_job: { id: 1, run_id: 2, labels: ['lambda-microvms'] },
  organization: { login: 'donkersgoed-org' }
};

test('matches queued workflow_job with the required label', () => {
  expect(matchesRunnerRequest(queuedEvent, 'lambda-microvms').matched).toBe(true);
});

test('rejects non-queued actions with a reason', () => {
  const r = matchesRunnerRequest({ ...queuedEvent, action: 'completed' }, 'lambda-microvms');
  expect(r.matched).toBe(false);
  expect(r.reason).toContain('queued');
});

test('rejects when required label is absent', () => {
  const r = matchesRunnerRequest(
    { ...queuedEvent, workflow_job: { id: 1, run_id: 2, labels: ['ubuntu-latest'] } },
    'lambda-microvms'
  );
  expect(r.matched).toBe(false);
  expect(r.reason).toContain('lambda-microvms');
});

test('parseWorkflowJobEvent round-trips JSON', () => {
  expect(parseWorkflowJobEvent(JSON.stringify(queuedEvent)).action).toBe('queued');
});
