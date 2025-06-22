/**
 * ConsoleMutex: Utility class for synchronizing console output
 * Prevents race conditions when multiple async operations write to the console
 */

export class ConsoleMutex {
  private static instance: ConsoleMutex;
  private queue: Array<() => Promise<void>> = [];
  private isExecuting = false;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {}

  /**
   * Get the singleton instance
   */
  public static getInstance(): ConsoleMutex {
    if (!ConsoleMutex.instance) {
      ConsoleMutex.instance = new ConsoleMutex();
    }
    return ConsoleMutex.instance;
  }

  /**
   * Execute a console operation with mutex protection
   * @param fn Function that performs console output
   */
  public async execute<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Add operation to the queue
      this.queue.push(async () => {
        try {
          const result = await Promise.resolve(fn());
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      // If not currently executing, start processing the queue
      if (!this.isExecuting) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the queue of console operations
   */
  private async processQueue(): Promise<void> {
    if (this.isExecuting || this.queue.length === 0) {
      return;
    }

    this.isExecuting = true;

    try {
      // Process the first operation in the queue
      const operation = this.queue.shift();
      if (operation) {
        await operation();
      }
    } finally {
      this.isExecuting = false;
      
      // Process the next operation in the queue if any
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }
}
