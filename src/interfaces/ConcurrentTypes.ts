/**
 * Types and interfaces for concurrent profile processing
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { ImageData, ScraperConfig } from './ScraperTypes';

/**
 * Configuration for concurrent processing
 */
export interface ConcurrentProcessingConfig {
  enabled: boolean;
  maxConcurrentProfiles: number;
  extractionTimeoutMs: number;
  queueMaxSize: number;
}

/**
 * Status of a profile being processed
 */
export enum ProfileStatus {
  WAITING = 'WAITING',
  EXTRACTING = 'EXTRACTING',
  DOWNLOADING = 'DOWNLOADING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Data for a single profile in the queue
 */
export interface ProfileQueueItem {
  username: string;
  status: ProfileStatus;
  imageData?: ImageData[];
  error?: Error;
  startTime?: number;
  extractionEndTime?: number;
  completionTime?: number;
}

/**
 * Interface for a worker that extracts profile data
 */
export interface ExtractionWorkerInterface {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Context needed for profile processing
 */
export interface ProfileContext {
  page: Page;
  browser: Browser;
  browserContext: BrowserContext;
  config: ScraperConfig;
}

/**
 * Events that can be emitted by the concurrent profile manager
 */
export enum ConcurrentProfileEvent {
  EXTRACTION_COMPLETE = 'EXTRACTION_COMPLETE',
  DOWNLOAD_COMPLETE = 'DOWNLOAD_COMPLETE',
  PROFILE_COMPLETE = 'PROFILE_COMPLETE',
  PROFILE_FAILED = 'PROFILE_FAILED',
  ALL_COMPLETE = 'ALL_COMPLETE',
}

/**
 * Result of image extraction operation
 */
export interface ExtractionResult {
  username: string;
  success: boolean;
  imageData?: ImageData[];
  error?: Error;
}

/**
 * Result statistics for concurrent processing
 */
export interface ConcurrentProcessingStats {
  totalProfiles: number;
  completedProfiles: number;
  failedProfiles: number;
  totalImagesExtracted: number;
  totalImagesDownloaded: number;
  totalImages: number;
}
