import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  productName!: string;

  /** Decimal string, e.g. "19.99" */
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'price must be a decimal string with up to 2 fractional digits',
  })
  price!: string;
}
