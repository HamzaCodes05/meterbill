import {
  Body, CanActivate, Controller, ExecutionContext, Global, Injectable, Module, Post, UnauthorizedException,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { IsEmail, IsString } from 'class-validator';

class LoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}

@Controller('auth')
class AuthController {
  constructor(private readonly jwt: JwtService) {}

  /** Single admin account from env, for the dashboard. Swap for real users in production. */
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const ok =
      dto.email.toLowerCase() === (process.env.ADMIN_EMAIL ?? 'admin@meterbill.dev') &&
      dto.password === (process.env.ADMIN_PASSWORD ?? 'admin1234');
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return { accessToken: await this.jwt.signAsync({ sub: 'admin', email: dto.email }) };
  }
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = (req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException();
    try {
      req.user = await this.jwt.verifyAsync(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

/** Usage ingestion is called by your backend services, so it uses a static key instead of a user login. */
@Injectable()
export class IngestKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.INGEST_KEY ?? 'dev-ingest-key';
    if (ctx.switchToHttp().getRequest().headers['x-api-key'] !== expected) throw new UnauthorizedException();
    return true;
  }
}

@Global()
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-secret', signOptions: { expiresIn: '12h' } })],
  controllers: [AuthController],
  providers: [JwtGuard, IngestKeyGuard],
  exports: [JwtModule, JwtGuard, IngestKeyGuard],
})
export class AuthModule {}
