import { Body, Controller, Post } from '@nestjs/common';
import { CreateProductService } from '../../application/create-product.service';
import { CreateProductDto } from './dto/create-product.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly createProduct: CreateProductService) {}

  @Post()
  create(@Body() body: CreateProductDto) {
    return this.createProduct.execute({
      productName: body.productName,
      price: body.price,
    });
  }
}
