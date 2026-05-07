import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CustomerNotFoundError,
  ProductNotFoundError,
} from '../../../domain/errors';
import type {
  OrderRepositoryPort,
  PlaceOrderInput,
  PlaceOrderResult,
} from '../../../domain/ports/order-repository.port';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaOrderRepository implements OrderRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: input.customerId },
      });
      if (!customer) {
        throw new CustomerNotFoundError(
          `Customer ${input.customerId} not found`,
        );
      }

      const uniqueProductIds = [
        ...new Set(input.items.map((i) => i.productId)),
      ];
      const products = await tx.product.findMany({
        where: { id: { in: uniqueProductIds } },
      });
      if (products.length !== uniqueProductIds.length) {
        throw new ProductNotFoundError('One or more products were not found');
      }

      const priceById = new Map(products.map((p) => [p.id, p.price] as const));

      const order = await tx.order.create({
        data: {
          customerId: input.customerId,
          totalAmount: new Prisma.Decimal(0),
        },
      });

      const placedItems: PlaceOrderResult['items'] = [];
      let total = new Prisma.Decimal(0);

      for (const line of input.items) {
        const unitPrice = priceById.get(line.productId)!;
        const subtotal = unitPrice.mul(line.quantity);
        total = total.add(subtotal);

        const row = await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId: line.productId,
            quantity: line.quantity,
            subtotal,
          },
        });

        placedItems.push({
          orderItemId: row.id,
          productId: row.productId,
          quantity: row.quantity,
          subtotal: subtotal.toFixed(2),
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { totalAmount: total },
      });

      return {
        orderId: order.id,
        totalAmount: total.toFixed(2),
        items: placedItems,
      };
    });
  }
}
