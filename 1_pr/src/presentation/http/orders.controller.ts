import { Body, Controller, Post } from '@nestjs/common';
import { PlaceOrderService } from '../../application/place-order.service';
import { PlaceOrderDto } from './dto/place-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly placeOrder: PlaceOrderService) {}

  @Post()
  create(@Body() body: PlaceOrderDto) {
    return this.placeOrder.execute({
      customerId: body.customerId,
      items: body.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
      })),
    });
  }
}
