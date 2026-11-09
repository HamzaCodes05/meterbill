import { Module } from '@nestjs/common';
import { AdminController, EventsController } from './admin/controllers';
import { CatalogService } from './admin/catalog.service';
import { AuthModule } from './auth/auth.module';
import { InvoicesService } from './billing/invoices.service';
import { UsageService } from './billing/usage.service';
import { DbModule } from './db';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [AdminController, EventsController],
  providers: [CatalogService, UsageService, InvoicesService],
})
export class AppModule {}
