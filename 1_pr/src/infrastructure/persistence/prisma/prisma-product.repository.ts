import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateProductInput,
  CreatedProduct,
} from '../../../domain/ports/product-repository.port';
import type { ProductRepositoryPort } from '../../../domain/ports/product-repository.port';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaProductRepository implements ProductRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async createProduct(input: CreateProductInput): Promise<CreatedProduct> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: {
          productName: input.productName,
          price: new Prisma.Decimal(input.price),
        },
      });
      return {
        id: row.id,
        productName: row.productName,
        price: row.price.toFixed(2),
      };
    });
  }
}
