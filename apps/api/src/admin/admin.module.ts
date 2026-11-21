import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminController } from './admin.controller';
import { ApiKeyAdminService } from './api-key-admin.service';
import { CompanyAdminService } from './company-admin.service';

/**
 * Platform administration: companies and their API keys.
 *
 * It depends on two things from elsewhere, both pure and both imported
 * directly rather than injected:
 *
 *   `ApiKeyService.hash`     - a static function. Importing it guarantees a
 *                              freshly issued key is hashed by the SAME
 *                              function authentication uses to look one up. A
 *                              second implementation would mean a new key
 *                              that cannot authenticate.
 *   `normaliseBlockedCategories` - likewise, so a company created with a
 *                              blocked list matches expenses the same way one
 *                              edited through F07 does.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [CompanyAdminService, ApiKeyAdminService],
})
export class AdminModule {}
