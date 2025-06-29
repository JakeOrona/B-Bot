/**
 * Types and interfaces for the Twitter X Image Scraper
 * UPDATED: Added media type support for videos/GIFs and storage reporting
 */

/**
 * Authentication credentials interface
 */
export interface AuthCredentials {
  username: string;
  password: string;
}

/**
 * Google Drive configuration interface
 */
export interface GoogleDriveConfig {
  enableUpload: boolean;
  credentialsPath: string;
  rootFolderId: string;
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
  googleDrive?: GoogleDriveConfig;
}

/**
 * Media type enumeration
 * ADDED: Support for different media types
 */
export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
  GIF = 'gif'
}

/**
 * Media data structure (renamed from ImageData to support all media types)
 * UPDATED: Added mediaType field and renamed from ImageData
 */
export interface MediaData {
  url: string;
  tweetId: string;
  username: string;
  index: number;
  mediaType: MediaType;
  originalFilename?: string;
}

/**
 * Legacy ImageData interface for backward compatibility
 * DEPRECATED: Use MediaData instead
 */
export interface ImageData extends MediaData {
  mediaType: MediaType.IMAGE;
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
 * UPDATED: Added media type breakdown
 */
export interface DownloadStats {
  total: number;
  successful: number;
  failed: number;
  skipped: number;
  // ADDED: Breakdown by media type
  byType: {
    images: number;
    videos: number;
    gifs: number;
  };
}

/**
 * Google Drive storage information
 * ADDED: Storage capacity reporting
 */
export interface StorageInfo {
  used: number;        // Bytes used
  total: number;       // Total bytes available
  available: number;   // Bytes available
  usedPercentage: number;
  formattedUsed: string;    // Human readable (e.g., "1.2 GB")
  formattedTotal: string;   // Human readable (e.g., "15 GB")
  formattedAvailable: string; // Human readable (e.g., "13.8 GB")
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
  CONFIG_ERROR = 'CONFIG_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR'
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

/**
 * Upload result interface for Google Drive uploads
 * UPDATED: Added storage information
 */
export interface UploadResult {
  successful: number;
  failed: number;
  skipped: number;
  total: number;
  // ADDED: Storage information after upload
  storageInfo?: StorageInfo;
}