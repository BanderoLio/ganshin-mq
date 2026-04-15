import { Module } from '@nestjs/common';
import {
  CUSTOMER_REPOSITORY,
  ORDER_REPOSITORY,
  PRODUCT_REPOSITORY,
} from '../../domain/ports/tokens';
import { PrismaCustomerRepository } from './prisma/prisma-customer.repository';
import { PrismaOrderRepository } from './prisma/prisma-order.repository';
import { PrismaProductRepository } from './prisma/prisma-product.repository';
import { PrismaService } from './prisma/prisma.service';

@Module({
  providers: [
    PrismaService,
    { provide: ORDER_REPOSITORY, useClass: PrismaOrderRepository },
    { provide: CUSTOMER_REPOSITORY, useClass: PrismaCustomerRepository },
    { provide: PRODUCT_REPOSITORY, useClass: PrismaProductRepository },
  ],
  exports: [
    PrismaService,
    ORDER_REPOSITORY,
    CUSTOMER_REPOSITORY,
    PRODUCT_REPOSITORY,
  ],
})
export class PersistenceModule {}
