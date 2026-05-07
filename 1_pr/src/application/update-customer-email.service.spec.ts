import { UpdateCustomerEmailService } from './update-customer-email.service';
import type { CustomerRepositoryPort } from '../domain/ports/customer-repository.port';

describe('UpdateCustomerEmailService', () => {
  it('delegates to customer repository', async () => {
    const updateEmail = jest.fn().mockResolvedValue(undefined);
    const customers: CustomerRepositoryPort = { updateEmail };
    const service = new UpdateCustomerEmailService(customers);

    await service.execute(5, 'x@y.z');

    expect(updateEmail).toHaveBeenCalledWith(5, 'x@y.z');
  });
});
