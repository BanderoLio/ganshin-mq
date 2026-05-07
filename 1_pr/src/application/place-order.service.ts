import { OrderValidationError } from '../domain/errors';
import type {
  OrderRepositoryPort,
  PlaceOrderInput,
  PlaceOrderResult,
} from '../domain/ports/order-repository.port';

export class PlaceOrderService {
  constructor(private readonly orders: OrderRepositoryPort) {}

  execute(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (input.items.length === 0) {
      return Promise.reject(
        new OrderValidationError('Order must contain at least one line item'),
      );
    }
    for (const line of input.items) {
      if (line.quantity < 1) {
        return Promise.reject(
          new OrderValidationError('Quantity must be at least 1'),
        );
      }
    }
    return this.orders.placeOrder(input);
  }
}
