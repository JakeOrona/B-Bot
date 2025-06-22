/**
 * Semaphore: Utility class for limiting concurrent operations
 */

export class Semaphore {
  private count: number;
  private waiting: Array<() => void> = [];

  /**
   * Create a new semaphore
   * @param count Maximum number of concurrent operations allowed
   */
  constructor(count: number) {
    this.count = count;
  }

  /**
   * Acquire a permit to perform an operation
   * @returns Promise that resolves when a permit is available
   */
  async acquire(): Promise<() => void> {
    if (this.count > 0) {
      this.count--;
      return this.release.bind(this);
    }

    // If no permits are available, wait for one
    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.count--;
        resolve(this.release.bind(this));
      });
    });
  }

  /**
   * Release a permit, allowing another operation to run
   */
  private release(): void {
    this.count++;
    
    // If there are operations waiting, let one proceed
    if (this.waiting.length > 0 && this.count > 0) {
      const next = this.waiting.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Execute a function with semaphore protection
   * @param fn Function to execute
   * @returns Promise resolving to the result of the function
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
