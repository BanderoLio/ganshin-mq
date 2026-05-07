import { Module } from '@nestjs/common';
import { CreateProductService } from './application/create-product.service';
import { PlaceOrderService } from './application/place-order.service';
import { UpdateCustomerEmailService } from './application/update-customer-email.service';
import {
  CUSTOMER_REPOSITORY,
  ORDER_REPOSITORY,
  PRODUCT_REPOSITORY,
} from './domain/ports/tokens';
import type { CustomerRepositoryPort } from './domain/ports/customer-repository.port';
import type { OrderRepositoryPort } from './domain/ports/order-repository.port';
import type { ProductRepositoryPort } from './domain/ports/product-repository.port';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { CustomersController } from './presentation/http/customers.controller';
import { OrdersController } from './presentation/http/orders.controller';
import { ProductsController } from './presentation/http/products.controller';

@Module({
  imports: [PersistenceModule],
  controllers: [OrdersController, CustomersController, ProductsController],
  providers: [
    {
      provide: PlaceOrderService,
      useFactory: (orders: OrderRepositoryPort) =>
        new PlaceOrderService(orders),
      inject: [ORDER_REPOSITORY],
    },
    {
      provide: UpdateCustomerEmailService,
      useFactory: (customers: CustomerRepositoryPort) =>
        new UpdateCustomerEmailService(customers),
      inject: [CUSTOMER_REPOSITORY],
    },
    {
      provide: CreateProductService,
      useFactory: (products: ProductRepositoryPort) =>
        new CreateProductService(products),
      inject: [PRODUCT_REPOSITORY],
    },
  ],
})
export class StoreModule {}
