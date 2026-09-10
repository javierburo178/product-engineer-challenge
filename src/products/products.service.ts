import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';
import { pgErrorCode, PG_FK_VIOLATION } from '../common/db-errors';

@Injectable()
export class ProductsService {
  /** Search cache keys issued this process, so they can be invalidated on write. */
  private readonly searchCacheKeys = new Set<string>();

  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    let saved: Product;
    try {
      saved = await this.productsRepository.save(product);
    } catch (err) {
      if (pgErrorCode(err) === PG_FK_VIOLATION) {
        throw new NotFoundException(
          `Category #${createProductDto.categoryId} not found`,
        );
      }
      throw err;
    }
    await this.invalidateSearchCache();
    return saved;
  }

  async remove(id: number): Promise<void> {
    // Delete by id (no entity load); a FK violation means the product is still
    // referenced by order items.
    let affected: number | null | undefined;
    try {
      ({ affected } = await this.productsRepository.delete(id));
    } catch (err) {
      if (pgErrorCode(err) === PG_FK_VIOLATION) {
        throw new ConflictException(
          `Product #${id} is referenced by existing orders and cannot be deleted`,
        );
      }
      throw err;
    }
    if (!affected) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    await this.invalidateSearchCache();
  }

  async searchProducts(query: string): Promise<Product[]> {
    const term = query.toLowerCase().trim();
    const cacheKey = `product-search:${term}`;
    this.searchCacheKeys.add(cacheKey);

    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const products = await this.productsRepository.find();
    const results = products.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.description || '').toLowerCase().includes(term),
    );

    await this.cacheManager.set(cacheKey, results, 60000);
    return results;
  }

  /** Drops every search result cached this process. */
  private async invalidateSearchCache(): Promise<void> {
    await Promise.all(
      [...this.searchCacheKeys].map((key) => this.cacheManager.del(key)),
    );
    this.searchCacheKeys.clear();
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({
      relations: ['parent', 'children'],
    });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    try {
      return await this.categoriesRepository.save(category);
    } catch (err) {
      if (pgErrorCode(err) === PG_FK_VIOLATION) {
        throw new NotFoundException(`Category #${dto.parentId} not found`);
      }
      throw err;
    }
  }

  async getCategoryTree(categoryId: number): Promise<any> {
    await this.findCategory(categoryId); // 404 if the root category is missing
    return this.buildCategoryTree(categoryId);
  }

  private async buildCategoryTree(categoryId: number): Promise<any> {
    // Load one level at a time and recurse, so the tree works at any depth.
    // The previous version reused a single-level `findCategory` result and
    // recursed into relations that were never loaded, throwing on level 2+.
    const category = await this.categoriesRepository.findOne({
      where: { id: categoryId },
      relations: ['children'],
    });

    return {
      id: category!.id,
      name: category!.name,
      children: await Promise.all(
        (category!.children ?? []).map((child) =>
          this.buildCategoryTree(child.id),
        ),
      ),
    };
  }

  async processProductBatch(productIds: number[]): Promise<{
    success: boolean;
    processed: number;
    failed: { id: number; reason: string }[];
  }> {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('productIds must be a non-empty array');
    }

    const failed: { id: number; reason: string }[] = [];
    let processed = 0;

    for (const id of productIds) {
      try {
        const product = await this.findOne(id);
        product.updatedAt = new Date();
        await this.productsRepository.save(product);
        processed++;
      } catch (error) {
        failed.push({
          id,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return { success: failed.length === 0, processed, failed };
  }
}
