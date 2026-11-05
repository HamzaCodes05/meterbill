import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { IngestKeyGuard, JwtGuard } from '../auth/auth.module';
import { InvoicesService } from '../billing/invoices.service';
import { UsageService } from '../billing/usage.service';
import { CatalogService } from './catalog.service';
import { CreateCustomerDto, CreatePlanDto, CreateSubscriptionDto, EventsDto, GenerateDto, PERIOD } from './dto';

@Controller('v1')
@UseGuards(JwtGuard)
export class AdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly usage: UsageService,
    private readonly invoices: InvoicesService,
  ) {}

  @Get('customers') customers() { return this.catalog.listCustomers(); }
  @Post('customers') createCustomer(@Body() dto: CreateCustomerDto) { return this.catalog.createCustomer(dto); }

  @Get('customers/:id/usage')
  customerUsage(@Param('id', ParseUUIDPipe) id: string, @Query('period') period = '') {
    if (!PERIOD.test(period)) throw new BadRequestException('period must be YYYY-MM');
    return this.usage.summary(id, period);
  }

  /** Lets the dashboard simulate usage with the admin login. Real traffic uses POST /v1/events + the ingest key,
   *  which must never be shipped to a browser. */
  @Post('simulate-events') @HttpCode(200)
  async simulate(@Body() dto: EventsDto) {
    return { results: await this.usage.ingest(dto.events) };
  }

  @Get('plans') plans() { return this.catalog.listPlans(); }
  @Post('plans') createPlan(@Body() dto: CreatePlanDto) { return this.catalog.createPlan(dto); }

  @Get('subscriptions') subscriptions() { return this.catalog.listSubscriptions(); }
  @Post('subscriptions') createSubscription(@Body() dto: CreateSubscriptionDto) { return this.catalog.createSubscription(dto); }
  @Post('subscriptions/:id/cancel') @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) { return this.catalog.cancelSubscription(id); }

  @Get('invoices')
  invoiceList(@Query('period') period?: string, @Query('status') status?: string, @Query('customerId') customerId?: string) {
    if (period && !PERIOD.test(period)) throw new BadRequestException('period must be YYYY-MM');
    if (status && !['draft', 'finalized', 'paid'].includes(status)) throw new BadRequestException('invalid status');
    if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw new BadRequestException('invalid customerId');
    return this.invoices.list({ period, status, customerId });
  }
  @Post('invoices/generate') @HttpCode(200) generate(@Body() dto: GenerateDto) { return this.invoices.generate(dto.period); }
  @Get('invoices/:id') invoice(@Param('id', ParseUUIDPipe) id: string) { return this.invoices.get(id); }
  @Post('invoices/:id/finalize') @HttpCode(200) finalize(@Param('id', ParseUUIDPipe) id: string) { return this.invoices.finalize(id); }
  @Post('invoices/:id/pay') @HttpCode(200) pay(@Param('id', ParseUUIDPipe) id: string) { return this.invoices.pay(id); }
}

@Controller('v1/events')
@UseGuards(IngestKeyGuard)
export class EventsController {
  constructor(private readonly usage: UsageService) {}

  /** Batch ingestion (1-1000 events). Each event gets its own result; a bad event never fails the batch. */
  @Post() @HttpCode(200)
  async ingest(@Body() dto: EventsDto) {
    const results = await this.usage.ingest(dto.events);
    return {
      accepted: results.filter((r) => r.status === 'accepted').length,
      duplicate: results.filter((r) => r.status === 'duplicate').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
      results,
    };
  }
}
