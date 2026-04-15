import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CustomerNotFoundError,
  EmailConflictError,
} from '../../../domain/errors';
import type { CustomerRepositoryPort } from '../../../domain/ports/customer-repository.port';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaCustomerRepository implements CustomerRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async updateEmail(customerId: number, email: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.customer.findUnique({
          where: { id: customerId },
        });
        if (!existing) {
          throw new CustomerNotFoundError(`Customer ${customerId} not found`);
        }
        await tx.customer.update({
          where: { id: customerId },
          data: { email },
        });
      });
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        throw err;
      }
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new EmailConflictError('Email is already in use');
      }
      throw err;
    }
  }
}
