export type OrderLineInput = {
  productId: number;
  quantity: number;
};

export type PlaceOrderInput = {
  customerId: number;
  items: OrderLineInput[];
};

export type PlacedOrderItem = {
  orderItemId: number;
  productId: number;
  quantity: number;
  subtotal: string;
};

export type PlaceOrderResult = {
  orderId: number;
  totalAmount: string;
  items: PlacedOrderItem[];
};

export interface OrderRepositoryPort {
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
}
