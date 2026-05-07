import { Body, Controller, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { UpdateCustomerEmailService } from '../../application/update-customer-email.service';
import { UpdateEmailDto } from './dto/update-email.dto';

@Controller('customers')
export class CustomersController {
  constructor(
    private readonly updateCustomerEmail: UpdateCustomerEmailService,
  ) {}

  @Patch(':customerId/email')
  async updateEmail(
    @Param('customerId', ParseIntPipe) customerId: number,
    @Body() body: UpdateEmailDto,
  ) {
    await this.updateCustomerEmail.execute(customerId, body.email);
    return { ok: true as const };
  }
}
