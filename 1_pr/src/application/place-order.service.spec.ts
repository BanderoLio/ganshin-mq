import { PlaceOrderService } from './place-order.service';
import { OrderValidationError } from '../domain/errors';
import type { OrderRepositoryPort } from '../domain/ports/order-repository.port';

describe('PlaceOrderService', () => {
  it('rejects empty line items', async () => {
    const placeOrder = jest.fn();
    const orders: OrderRepositoryPort = { placeOrder };
    const service = new PlaceOrderService(orders);

    await expect(
      service.execute({ customerId: 1, items: [] }),
    ).rejects.toBeInstanceOf(OrderValidationError);

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('rejects non-positive quantity', async () => {
    const placeOrder = jest.fn();
    const orders: OrderRepositoryPort = { placeOrder };
    const service = new PlaceOrderService(orders);

    await expect(
      service.execute({
        customerId: 1,
        items: [{ productId: 1, quantity: 0 }],
      }),
    ).rejects.toBeInstanceOf(OrderValidationError);

    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('delegates to repository when input is valid', async () => {
    const placeOrder = jest.fn().mockResolvedValue({
      orderId: 9,
      totalAmount: '10.00',
      items: [
        {
          orderItemId: 1,
          productId: 2,
          quantity: 1,
          subtotal: '10.00',
        },
      ],
    });
    const orders: OrderRepositoryPort = { placeOrder };
    const service = new PlaceOrderService(orders);
    const input = {
      customerId: 3,
      items: [{ productId: 2, quantity: 1 }],
    };

    const result = await service.execute(input);

    expect(placeOrder).toHaveBeenCalledWith(input);
    expect(result.orderId).toBe(9);
  });
});
