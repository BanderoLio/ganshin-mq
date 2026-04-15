export type CreateProductInput = {
  productName: string;
  price: string;
};

export type CreatedProduct = {
  id: number;
  productName: string;
  price: string;
};

export interface ProductRepositoryPort {
  createProduct(input: CreateProductInput): Promise<CreatedProduct>;
}
