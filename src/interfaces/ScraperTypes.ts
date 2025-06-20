/**
 * Types and interfaces for the Twitter X Image Scraper
 */

/**
 * Authentication credentials interface
 */
export interface AuthCredentials {
  username: string;
  password: string;
}

/**
 * Configuration interface for the scraper
 */
export interface ScraperConfig {
  headless: boolean;
  downloadPath: string;
  delayBetweenScrolls: number;
  maxScrolls: number;
  rateLimitDelay: number;
  maxRetries: number;
  retryDelay: number;
}

/**
 * Image data structure
 */
export interface ImageData {
  url: string;
  tweetId: string;
  username: string;
  index: number;
}

/**
 * Twitter API response structure (simplified)
 */
export interface TwitterApiResponse {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: any[];
          };
        };
      };
    };
  };
}

/**
 * Download statistics
 */
export interface DownloadStats {
  total: number;
  successful: number;
  failed: number;
  skipped: number;
}

/**
 * Page base interface
 */
export interface Page {
  url: string;
  navigate(): Promise<void>;
}

/**
 * Error types for the scraper
 */
export enum ScraperErrorType {
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  NAVIGATION_ERROR = 'NAVIGATION_ERROR',
  SCRAPING_ERROR = 'SCRAPING_ERROR',
  DOWNLOAD_ERROR = 'DOWNLOAD_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  PRIVATE_ACCOUNT_ERROR = 'PRIVATE_ACCOUNT_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR'
}

/**
 * Custom error class for scraper
 */
export class ScraperError extends Error {
  type: ScraperErrorType;
  
  constructor(message: string, type: ScraperErrorType) {
    super(message);
    this.type = type;
    this.name = 'ScraperError';
  }
}
