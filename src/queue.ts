export interface RunnerRequestMessage {
  org: string;
  runId?: number;
  labels: string[];
}
