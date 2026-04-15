import { CreateProductService } from './create-product.service';
import type { ProductRepositoryPort } from '../domain/ports/product-repository.port';

describe('CreateProductService', () => {
  it('delegates to product repository', async () => {
    const createProduct = jest.fn().mockResolvedValue({
      id: 1,
      productName: 'X',
      price: '1.00',
    });
    const products: ProductRepositoryPort = { createProduct };
    const service = new CreateProductService(products);
    const input = { productName: 'X', price: '1.00' };

    const created = await service.execute(input);

    expect(createProduct).toHaveBeenCalledWith(input);
    expect(created.id).toBe(1);
  });
});
