export class InfrastructureUnavailableError extends Error {
  constructor(message = "A required service is temporarily unavailable") {
    super(message);
    this.name = "InfrastructureUnavailableError";
  }
}
