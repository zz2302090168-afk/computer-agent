export class ToolExecutionError extends Error {
  observation: unknown;
  constructor(message: string, observation: unknown) {
    super(message);
    this.name = 'ToolExecutionError';
    this.observation = observation;
  }
}
