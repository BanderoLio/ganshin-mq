import type { CustomerRepositoryPort } from '../domain/ports/customer-repository.port';

export class UpdateCustomerEmailService {
  constructor(private readonly customers: CustomerRepositoryPort) {}

  execute(customerId: number, email: string): Promise<void> {
    return this.customers.updateEmail(customerId, email);
  }
}
