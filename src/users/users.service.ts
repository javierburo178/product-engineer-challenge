import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { pgErrorCode, PG_UNIQUE_VIOLATION, PG_FK_VIOLATION } from '../common/db-errors';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<User[]> {
    const cacheKey = 'users:all';
    const cached = await this.cacheManager.get<User[]>(cacheKey);
    if (cached) {
      return cached;
    }
    
    const users = await this.usersRepository.find();
    await this.cacheManager.set(cacheKey, users, 60000);
    return users;
  }

  async findOne(id: number): Promise<User> {
    const cacheKey = `user:${id}`;
    const cached = await this.cacheManager.get<User>(cacheKey);
    if (cached) {
      return cached;
    }

    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User #${id} not found`);
    }
    
    await this.cacheManager.set(cacheKey, user, 60000);
    return user;
  }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const user = this.usersRepository.create(createUserDto);

    let saved: User;
    try {
      saved = await this.usersRepository.save(user);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          `A user with email "${createUserDto.email}" already exists`,
        );
      }
      throw err;
    }

    await this.cacheManager.del('users:all');
    return saved;
  }

  async remove(id: number): Promise<void> {
    // Delete by id: `findOne` can return a cached plain object, and this avoids
    // loading the row at all. A FK violation means the user still has orders.
    let affected: number | null | undefined;
    try {
      ({ affected } = await this.usersRepository.delete(id));
    } catch (err) {
      if (pgErrorCode(err) === PG_FK_VIOLATION) {
        throw new ConflictException(
          `User #${id} has related orders and cannot be deleted`,
        );
      }
      throw err;
    }

    if (!affected) {
      throw new NotFoundException(`User #${id} not found`);
    }
    await this.cacheManager.del('users:all');
    await this.cacheManager.del(`user:${id}`);
  }
}
