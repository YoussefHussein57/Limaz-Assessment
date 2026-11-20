import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/**
 * Global because the authentication guard is registered application-wide and
 * needs ApiKeyService and SessionService wherever it runs. Exporting them
 * keeps later feature modules from re-importing this one just to be guarded.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [ApiKeyService, AuthService, PasswordService, SessionService],
  exports: [ApiKeyService, AuthService, PasswordService, SessionService],
})
export class AuthModule {}
