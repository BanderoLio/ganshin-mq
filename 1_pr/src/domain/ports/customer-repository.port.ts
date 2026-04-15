export interface CustomerRepositoryPort {
  updateEmail(customerId: number, email: string): Promise<void>;
}
