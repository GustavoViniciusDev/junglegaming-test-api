export class InvalidReadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReadRequestError";
  }
}

export class ReadResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} was not found`);
    this.name = "ReadResourceNotFoundError";
  }
}
