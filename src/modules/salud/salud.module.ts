import { Module } from '@nestjs/common';
import { SaludController } from './salud.controller';
import { SaludRepository } from './salud.repository';
import { SaludService } from './salud.service';

@Module({
  controllers: [SaludController],
  providers: [SaludService, SaludRepository],
})
export class SaludModule {}
