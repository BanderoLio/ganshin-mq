import type {
  CreateProductInput,
  CreatedProduct,
} from '../domain/ports/product-repository.port';
import type { ProductRepositoryPort } from '../domain/ports/product-repository.port';

export class CreateProductService {
  constructor(private readonly products: ProductRepositoryPort) {}

  execute(input: CreateProductInput): Promise<CreatedProduct> {
    return this.products.createProduct(input);
  }
}
