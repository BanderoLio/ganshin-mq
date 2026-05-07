import { IsEmail, IsString, MaxLength } from 'class-validator';

export class UpdateEmailDto {
  @IsString()
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
