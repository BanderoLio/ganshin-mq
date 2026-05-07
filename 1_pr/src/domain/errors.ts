export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CustomerNotFoundError extends DomainError {}

export class ProductNotFoundError extends DomainError {}

export class EmailConflictError extends DomainError {}

export class OrderValidationError extends DomainError {}
