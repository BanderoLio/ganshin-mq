import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/presentation/http/filters/domain-exception.filter';
import { PrismaService } from '../src/infrastructure/persistence/prisma/prisma.service';

describe('Store scenarios (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.product.deleteMany();
    await prisma.customer.deleteMany();
  });

  describe('Scenario 1: place order', () => {
    it('creates order, line items, and sets TotalAmount from subtotals', async () => {
      const customer = await prisma.customer.create({
        data: {
          firstName: 'Ann',
          lastName: 'Smith',
          email: 'ann@example.com',
        },
      });
      const p1 = await prisma.product.create({
        data: { productName: 'Pen', price: '2.50' },
      });
      const p2 = await prisma.product.create({
        data: { productName: 'Notebook', price: '10.00' },
      });

      const res = await request(app.getHttpServer())
        .post('/orders')
        .send({
          customerId: customer.id,
          items: [
            { productId: p1.id, quantity: 2 },
            { productId: p2.id, quantity: 1 },
          ],
        })
        .expect(201);

      const placed = res.body as {
        orderId: number;
        totalAmount: string;
        items: unknown[];
      };
      expect(placed.totalAmount).toBe('15.00');
      expect(placed.items).toHaveLength(2);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: placed.orderId },
      });
      expect(order.totalAmount.toFixed(2)).toBe('15.00');

      const items = await prisma.orderItem.findMany({
        where: { orderId: order.id },
      });
      expect(items).toHaveLength(2);
      const sum = items.reduce((acc, i) => acc + Number(i.subtotal), 0);
      expect(sum).toBe(15);
    });
  });

  describe('Scenario 2: update customer email', () => {
    it('updates email atomically', async () => {
      const customer = await prisma.customer.create({
        data: {
          firstName: 'Bob',
          lastName: 'Jones',
          email: 'bob@example.com',
        },
      });

      await request(app.getHttpServer())
        .patch(`/customers/${customer.id}/email`)
        .send({ email: 'bob.new@example.com' })
        .expect(200);

      const updated = await prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      expect(updated.email).toBe('bob.new@example.com');
    });

    it('returns 409 when email is already taken', async () => {
      await prisma.customer.create({
        data: {
          firstName: 'A',
          lastName: 'One',
          email: 'taken@example.com',
        },
      });
      const other = await prisma.customer.create({
        data: {
          firstName: 'B',
          lastName: 'Two',
          email: 'other@example.com',
        },
      });

      await request(app.getHttpServer())
        .patch(`/customers/${other.id}/email`)
        .send({ email: 'taken@example.com' })
        .expect(409);
    });
  });

  describe('Scenario 3: create product', () => {
    it('persists a new product', async () => {
      const res = await request(app.getHttpServer())
        .post('/products')
        .send({ productName: 'Mug', price: '7.25' })
        .expect(201);

      const created = res.body as {
        id: number;
        productName: string;
        price: string;
      };
      expect(created.productName).toBe('Mug');
      expect(created.price).toBe('7.25');

      const row = await prisma.product.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.productName).toBe('Mug');
      expect(row.price.toFixed(2)).toBe('7.25');
    });
  });
});
