// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import type {
  ProductConfiguration,
  ProductRepositoryConfiguration,
  ResolvedProductionConfiguration,
} from "./configuration.js";

export type TaskRoute = {
  product: ProductConfiguration;
  repositories: ProductRepositoryConfiguration[];
};

export type TaskRoutingAttentionCode =
  | "product-not-declared"
  | "repository-not-declared"
  | "stage-repository-not-declared"
  | "stage-repository-undeclared";

export class TaskRoutingAttentionError extends Error {
  constructor(
    readonly code: TaskRoutingAttentionCode,
    readonly taskId: number,
    message: string,
  ) {
    super(message);
    this.name = "TaskRoutingAttentionError";
  }
}

export class ProductRoutingCatalog {
  private readonly productsByName: ReadonlyMap<string, ProductConfiguration>;
  private readonly repositoriesByName: ReadonlyMap<
    string,
    {
      product: ProductConfiguration;
      repository: ProductRepositoryConfiguration;
    }
  >;
  private tasksById = new Map<number, BoardTask>();

  constructor(private readonly configuration: ResolvedProductionConfiguration) {
    this.productsByName = new Map(
      configuration.products.map((product) => [product.name, product]),
    );
    this.repositoriesByName = new Map(
      configuration.products.flatMap((product) =>
        product.repos.map((repository) => [
          repository.name,
          { product, repository },
        ]),
      ),
    );
  }

  update(tasks: readonly BoardTask[]): void {
    this.tasksById = new Map(tasks.map((task) => [task.id, task]));
  }

  route(task: BoardTask): TaskRoute {
    const parent =
      task.parent === undefined ? undefined : this.tasksById.get(task.parent);
    const declaredRepos = task.repos ?? parent?.repos;
    const explicitProduct = task.product ?? parent?.product;
    if (
      task.parent !== undefined &&
      task.product !== undefined &&
      parent?.product !== undefined &&
      task.product !== parent.product
    ) {
      throw new TaskRoutingAttentionError(
        "product-not-declared",
        task.id,
        `Task ${task.id} declares product '${task.product}' outside epic ${task.parent}`,
      );
    }

    let product =
      explicitProduct === undefined
        ? undefined
        : this.productsByName.get(explicitProduct);
    if (explicitProduct !== undefined && product === undefined) {
      throw new TaskRoutingAttentionError(
        "product-not-declared",
        task.id,
        `Task ${task.id} declares unknown product '${explicitProduct}'`,
      );
    }
    if (product === undefined && declaredRepos !== undefined) {
      const products = new Set(
        declaredRepos
          .map((name) => this.repositoriesByName.get(name)?.product)
          .filter(
            (value): value is ProductConfiguration => value !== undefined,
          ),
      );
      if (products.size === 1) product = [...products][0];
    }
    if (product === undefined && this.configuration.products.length === 1) {
      product = this.configuration.products[0];
    }
    if (product === undefined) {
      throw new TaskRoutingAttentionError(
        "product-not-declared",
        task.id,
        `Task ${task.id} does not identify one configured product`,
      );
    }

    const names = declaredRepos ?? product.repos.map(({ name }) => name);
    const repositories = names.map((name) => {
      const configured = this.repositoriesByName.get(name);
      if (configured?.product.name !== product!.name) {
        throw new TaskRoutingAttentionError(
          "repository-not-declared",
          task.id,
          `Task ${task.id} references repository '${name}' outside product '${product!.name}'`,
        );
      }
      return configured.repository;
    });
    return { product, repositories };
  }

  repositoryForStage(
    task: BoardTask,
    requiredRepositoryName?: string,
  ): ProductRepositoryConfiguration {
    const route = this.route(task);
    if (requiredRepositoryName === undefined) {
      if (route.repositories.length !== 1) {
        throw new TaskRoutingAttentionError(
          "stage-repository-not-declared",
          task.id,
          `Task ${task.id} targets more than one repository but its stage declares none`,
        );
      }
      return route.repositories[0]!;
    }
    const repository = route.repositories.find(
      ({ name }) => name === requiredRepositoryName,
    );
    if (repository === undefined) {
      throw new TaskRoutingAttentionError(
        "stage-repository-undeclared",
        task.id,
        `Task ${task.id} stage requires undeclared repository '${requiredRepositoryName}'`,
      );
    }
    return repository;
  }
}
