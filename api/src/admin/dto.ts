import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max,
  MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';

export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateCustomerDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsEmail() email: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) taxRateBps?: number;
}

class TierDto {
  @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) upTo: number | null;
  @IsString() unitPrice: string;
}
class UsagePricingDto {
  @IsString() metric: string;
  @IsString() @MinLength(1) @MaxLength(80) label: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => TierDto) tiers: TierDto[];
}
export class CreatePlanDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsInt() @Min(0) @Max(100_000_000) baseFeeCents: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) seatFeeCents?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => UsagePricingDto)
  usagePricing?: UsagePricingDto[];
}

export class CreateSubscriptionDto {
  @IsUUID() customerId: string;
  @IsUUID() planId: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) seats?: number;
  @Matches(DATE, { message: 'startedOn must be YYYY-MM-DD' }) startedOn: string;
}

export class GenerateDto {
  @Matches(PERIOD, { message: 'period must be YYYY-MM' }) period: string;
}

export class EventDto {
  @IsUUID() customerId: string;
  @Matches(/^[a-z][a-z0-9_]{0,47}$/, { message: 'metric must be lowercase letters, digits and underscores' }) metric: string;
  @IsInt() @Min(1) @Max(1_000_000_000) quantity: number;
  @IsISO8601({ strict: true }) timestamp: string;
  @IsString() @MinLength(1) @MaxLength(128) idempotencyKey: string;
}
export class EventsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => EventDto) events: EventDto[];
}
