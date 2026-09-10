import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThanOrEqual } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { Product } from '../products/product.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { withRetry } from '../common/with-retry';
import { toCents, fromCents } from '../common/money';

const paymentService = {
  async processPayment(orderId: number, amount: number): Promise<{ success: boolean; transactionId: string }> {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (Math.random() < 0.1) {
      throw new Error('Payment service unavailable');
    }
    
    return { success: true, transactionId: `TXN-${Date.now()}` };
  }
};

@Injectable()
export class OrdersService {
  private maxRetries = 3;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    private usersService: UsersService,
    private dataSource: DataSource,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Order[]> {
    return this.ordersRepository.find({ 
      relations: ['user', 'items', 'items.product'] 
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.ordersRepository.findOne({ 
      where: { id },
      relations: ['user', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  async findByUser(userId: number): Promise<Order[]> {
    return this.ordersRepository.find({ 
      where: { userId },
      relations: ['items', 'items.product'],
    });
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const user = await this.usersService.findOne(createOrderDto.userId);

    // One transaction for the whole order: if any item fails (missing product,
    // not enough stock, DB error) everything below is rolled back — no orphan
    // order, no partial items, no phantom stock movement.
    const orderId = await this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        manager.create(Order, {
          userId: user.id,
          status: OrderStatus.PENDING,
          total: 0,
        }),
      );

      let totalCents = 0;
      for (const itemDto of createOrderDto.items) {
        const product = await manager.findOne(Product, {
          where: { id: itemDto.productId },
        });
        if (!product) {
          throw new NotFoundException(`Product #${itemDto.productId} not found`);
        }

        // Atomic conditional decrement: Postgres computes `stock - qty` and the
        // `stock >= qty` guard means two concurrent orders can never both pass.
        const decremented = await manager.decrement(
          Product,
          { id: product.id, stock: MoreThanOrEqual(itemDto.quantity) },
          'stock',
          itemDto.quantity,
        );
        if (!decremented.affected) {
          throw new BadRequestException(`Not enough stock for ${product.name}`);
        }

        await manager.insert(OrderItem, {
          orderId: order.id,
          productId: product.id,
          quantity: itemDto.quantity,
          price: product.price,
        });

        totalCents += toCents(product.price) * itemDto.quantity;
      }

      order.total = fromCents(totalCents);
      await manager.save(order);
      return order.id;
    });

    return this.findOne(orderId);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }

  async processPayment(orderId: number): Promise<{ success: boolean; transactionId: string }> {
    const order = await this.findOne(orderId);

    let result: { success: boolean; transactionId: string };
    try {
      result = await withRetry(async () => {
        const attempt = await paymentService.processPayment(orderId, Number(order.total));
        if (!attempt.success) {
          throw new Error('Payment was declined');
        }
        return attempt;
      }, this.maxRetries);
    } catch (error) {
      throw new ServiceUnavailableException(
        `Payment failed after ${this.maxRetries} attempts: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    order.status = OrderStatus.CONFIRMED;
    await this.ordersRepository.save(order);
    return result;
  }

  async cancel(id: number): Promise<Order> {
    await this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, { where: { id }, relations: ['items'] });
      if (!order) {
        throw new NotFoundException(`Order #${id} not found`);
      }
      if (order.status !== OrderStatus.PENDING) {
        throw new BadRequestException('Only pending orders can be cancelled');
      }

      // Atomic relative increment to put stock back — no read-modify-write.
      for (const item of order.items) {
        await manager.increment(Product, { id: item.productId }, 'stock', item.quantity);
      }

      order.status = OrderStatus.CANCELLED;
      await manager.save(order);
    });

    return this.findOne(id);
  }

  async getOrderWithFullDetails(id: number): Promise<any> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product', 'items.product.category'],
    });
    
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    const enriched: any = { ...order };
    enriched.user = { ...order.user };
    enriched.user.latestOrder = { ...order, user: undefined };

    return JSON.parse(JSON.stringify(enriched));
  }
}
