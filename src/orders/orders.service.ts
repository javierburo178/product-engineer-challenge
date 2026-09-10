import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { withRetry } from '../common/with-retry';

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
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    private usersService: UsersService,
    private productsService: ProductsService,
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
    
    const order = this.ordersRepository.create({
      userId: user.id,
      status: OrderStatus.PENDING,
    });
    const savedOrder = await this.ordersRepository.save(order);
    
    let total = 0;
    for (const itemDto of createOrderDto.items) {
      const product = await this.productsService.findOne(itemDto.productId);
      
      if (product.stock < itemDto.quantity) {
        throw new BadRequestException(`Not enough stock for ${product.name}`);
      }
      
      const orderItem = this.orderItemsRepository.create({
        orderId: savedOrder.id,
        productId: product.id,
        quantity: itemDto.quantity,
        price: product.price,
      });
      
      await this.orderItemsRepository.save(orderItem);
      total += product.price * itemDto.quantity;
      this.productsService.updateStock(product.id, product.stock - itemDto.quantity);
    }
    
    savedOrder.total = total;
    await this.ordersRepository.save(savedOrder);
    
    return this.findOne(savedOrder.id);
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
    const order = await this.findOne(id);
    
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }
    
    for (const item of order.items) {
      const product = await this.productsService.findOne(item.productId);
      await this.productsService.updateStock(product.id, product.stock + item.quantity);
    }
    
    order.status = OrderStatus.CANCELLED;
    return this.ordersRepository.save(order);
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
