import { Controller } from '@nestjs/common';
import { WorkersService } from './workers.service';

@Controller('workers')
export class WorkersController {
  constructor(private readonly workersService: WorkersService) {}
}
