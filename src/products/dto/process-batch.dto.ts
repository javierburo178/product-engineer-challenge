import { IsArray, ArrayNotEmpty, IsInt } from 'class-validator';

export class ProcessBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  productIds: number[];
}
