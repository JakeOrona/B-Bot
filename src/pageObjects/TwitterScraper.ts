/**
 * TwitterScraper: Core class for scraping images from Twitter/X profiles
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { 
  ImageData, 
  ScraperConfig, 
  ScraperError, 
  ScraperErrorType, 
  UploadResult 
} from '../interfaces/ScraperTypes';
import { ImageDownloader } from '../utilities/ImageDownloader';
import { GoogleDriveUploader } from '../utilities/GoogleDriveUploader';
import { FileCleanup } from '../utilities/FileCleanup';
import { ProgressLogger } from '../utilities/ProgressLogger';
import { Semaphore } from '../utilities/Semaphore';
import fs from 'fs';
import path from 'path';

export class TwitterScraper extends BasePage {
  private config: ScraperConfig;
  private imageDownloader!: ImageDownloader; // Will be initialized in constructor if not in extraction-only mode
  private googleDriveUploader?: GoogleDriveUploader;
  private currentUsername: string = '';
  private downloadedImagePaths: string[] = [];
  private progressLogger: ProgressLogger;
  private extractionOnlyMode: boolean = false;
  
  /**
   * Constructor for TwitterScraper
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   * @param config Scraper configuration
   * @param extractionOnly Whether this instance should be extraction-only (no downloads)
   */
  constructor(
    page: Page,
    context: BrowserContext,
    browser: Browser,
    config: ScraperConfig,
    extractionOnly: boolean = false
  ) {
    super(page, context, browser);
    this.config = config;
    this.extractionOnlyMode = extractionOnly;
    this.progressLogger = ProgressLogger.getInstance();
    
    // Initialize ImageDownloader unless in extraction-only mode
    if (!this.extractionOnlyMode) {
      this.imageDownloader = new ImageDownloader(config.downloadPath);
      
      // Initialize Google Drive uploader if enabled
      if (config.googleDrive?.enableUpload && config.googleDrive?.rootFolderId) {
        try {
          this.googleDriveUploader = new GoogleDriveUploader(
            config.googleDrive.credentialsPath,
            config.googleDrive.rootFolderId
          );
          this.progressLogger.info('Google Drive integration enabled');
        } catch (error) {
          this.progressLogger.error('Failed to initialize Google Drive uploader', error as Error);
        }
      }
    }
  }
  
  // Profile and navigation locators
  private readonly emptyStateLocator = this.page.locator('div[data-testid="emptyState"]');
  
  // Media and tweet locators
  private readonly tweetPhotoLocator = this.page.locator('img[src*="pbs.twimg.com"]');
  private readonly tweetLocator = this.page.locator('article[data-testid="tweet"]');
  private readonly cellDivLocator = this.page.locator('div[data-testid="cellInnerDiv"]');
  
  // Account status locators
  private readonly privateAccountLocator = this.page.locator('span:has-text("These posts are protected")');
  private readonly suspendedAccountLocator = this.page.locator('span:has-text("Account suspended")');
  
  /**
   * Navigate to a Twitter profile's media tab
   * @param username Twitter username to navigate to
   */
  public async navigateToProfileMediaTab(username: string): Promise<void> {
    this.currentUsername = username;
    const profileUrl = `https://x.com/${username}/media`;
    
    try {
      await this.navigateWithRetry(profileUrl, this.config.maxRetries, this.config.retryDelay);
      
      // Check if profile exists
      if (await this.emptyStateLocator.isVisible()) {
        throw new ScraperError(
          `Profile not found or is private: ${username}`,
          ScraperErrorType.NAVIGATION_ERROR
        );
      }
      
      // Ensure we're on the media tab by clicking it if necessary
      try {
        const mediaTab = this.getMediaTabLocator(username);
        if (await mediaTab.isVisible()) {
          // Only click if it's not already selected (aria-selected attribute)
          const isSelected = await mediaTab.getAttribute('aria-selected');
          if (isSelected !== 'true') {
            this.logger.info('Media tab exists but not selected, clicking it...');
            await mediaTab.click();
            await this.page.waitForLoadState('networkidle', { timeout: 5000 });
          }
        }
      } catch (tabError) {
        this.logger.warn(`Could not verify media tab: ${(tabError as Error).message}`);
        // Continue anyway as we already navigated to the media URL directly
      }
      
      // Wait a moment for any dynamic content to load
      await this.wait(1000);
      
      this.logger.info(`Successfully navigated to ${username}'s media timeline`);
    } catch (error) {
      if (error instanceof ScraperError) {
        throw error;
      }
      throw new ScraperError(
        `Failed to navigate to ${username}'s profile: ${(error as Error).message}`,
        ScraperErrorType.NAVIGATION_ERROR
      );
    }
  }
  
  /**
   * Scroll and load media content
   * @param maxScrolls Maximum number of scrolls to perform
   * @returns Number of images found
   */
  public async scrollAndLoadMedia(
    maxScrolls: number = this.config.maxScrolls,
    workerContext?: { workerId?: number; username?: string }
  ): Promise<number> {
    try {
      let previousHeight = 0;
      let scrollCount = 0;
      let sameHeightCount = 0;
      const progressLogger = ProgressLogger.getInstance();
      
      // Create a worker context object for logging
      const context = workerContext || { username: this.currentUsername };
      
      // Create a unique scrolling progress bar ID
      const scrollProgressId = `scroll-${context.username || this.currentUsername}`;
      
      // Log the start of scrolling
      await progressLogger.info(`Starting to scroll and load media for @${this.currentUsername}`, undefined, undefined, context);
      
      // Create a scroll progress bar in concise mode
      await progressLogger.createProgressBar(
        scrollProgressId,
        maxScrolls,
        'Scrolling',
        this.currentUsername,
        context
      );
      
      while (scrollCount < maxScrolls && sameHeightCount < 3) {
        // Get current scroll height
        const currentHeight = await this.page.evaluate(() => document.body.scrollHeight);
        
        // If we've reached the bottom (same height multiple times), stop scrolling
        if (currentHeight === previousHeight) {
          sameHeightCount++;
        } else {
          sameHeightCount = 0;
        }
        
        // Scroll to bottom of page
        await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await this.wait(this.config.delayBetweenScrolls);
        
        previousHeight = currentHeight;
        scrollCount++;
        
        // Update progress bar
        await progressLogger.updateProgress(
          scrollProgressId, 
          scrollCount, 
          undefined,
          context
        );
      }
      
      // Count the number of images found using updated selector for Twitter media images
      const imageCount = await this.page.evaluate(() => {
        const images = document.querySelectorAll('img[src*="pbs.twimg.com"]');
        return images.length;
      });
      
      // Complete the progress bar
      await progressLogger.completeProgress(
        scrollProgressId,
        `Found ${imageCount} images after scrolling ${scrollCount} times for @${this.currentUsername}`,
        context
      );
      
      await progressLogger.success(`Found ${imageCount} images after scrolling ${scrollCount} times for @${this.currentUsername}`, undefined, context);
      return imageCount;
    } catch (error) {
      throw new ScraperError(
        `Error while scrolling for media: ${(error as Error).message}`,
        ScraperErrorType.SCRAPING_ERROR
      );
    }
  }
  
  /**
   * Extract image URLs from the current page
   * @returns Array of image data objects
   */
  public async extractImageUrls(): Promise<ImageData[]> {
    try {
      this.logger.info(`Extracting image URLs from ${this.currentUsername}'s media`);
      
      // For complex operations like this where we need to extract data from the DOM,
      // we need to use page.evaluate to perform DOM manipulation directly
      const imageData = await this.page.evaluate((username) => {
        const images: {url: string, tweetId: string, username: string, index: number}[] = [];
        
        // Debug: Log what we're finding
        const allImages = document.querySelectorAll('img');
        const twitterImages = document.querySelectorAll('img[src*="pbs.twimg.com"]');
        console.log(`Total images found: ${allImages.length}`);
        console.log(`Twitter media images found: ${twitterImages.length}`);
        
        // Try multiple selectors for tweet containers
        const tweetSelectors = [
            'article[data-testid="tweet"]',
            '[data-testid="tweet"]', 
            'div[data-testid="cellInnerDiv"]'
        ];
        
        let tweets: Element[] = [];
        for (const selector of tweetSelectors) {
            const foundTweets = document.querySelectorAll(selector);
            if (foundTweets.length > 0) {
                tweets = Array.from(foundTweets);
                console.log(`Found ${tweets.length} tweets using selector: ${selector}`);
                break;
            }
        }
        
        if (tweets.length === 0) {
            console.log('No tweet containers found. Falling back to direct image extraction.');
            // If we can't find tweet containers, extract images directly
            const directImages = document.querySelectorAll('img[src*="pbs.twimg.com"]');
            Array.from(directImages).forEach((img, index) => {
                const src = (img as Element).getAttribute('src');
                if (!src) return;
                
                // Get the largest version of the image by modifying the URL
                const originalUrl = src.replace(/[&?]name=\w+/, '&name=orig');
                
                images.push({
                    url: originalUrl,
                    tweetId: `unknown-${Date.now()}-${index}`, // Generate fallback ID
                    username,
                    index
                });
            });
            
            return images;
        }
        
        // Process each found tweet
        Array.from(tweets).forEach((tweet, tweetIndex) => {
            // Enhanced tweet ID extraction
            let tweetId = null;
            
            // Look for multiple possible link patterns
            const linkSelectors = [
                'time a[href*="/status/"]',
                'a[href*="/status/"]',
                '[data-testid="Time"] a'
            ];
            
            for (const selector of linkSelectors) {
                const linkElement = tweet.querySelector(selector);
                if (linkElement) {
                    const href = linkElement.getAttribute('href');
                    const match = href?.match(/\/status\/(\d+)/);
                    if (match) {
                        tweetId = match[1];
                        break;
                      }
                }
            }
            
            // If we still couldn't find a tweet ID, generate a fallback
            if (!tweetId) {
                tweetId = `tweet-${tweetIndex}-${Date.now()}`;
            }
            
            // Get all image elements in the tweet using improved selector
            const imageElements = tweet.querySelectorAll('img[src*="pbs.twimg.com"]');
            
            if (imageElements.length === 0) {
                console.log(`No images found in tweet ${tweetId} using improved selector`);
            }
            
            // Extract image URLs
            Array.from(imageElements).forEach((img, index) => {
                const src = (img as Element).getAttribute('src');
                if (!src) return;
                
                // Get the largest version of the image by modifying the URL
                // Handle both formats: ?name=small and &name=small
                const originalUrl = src.replace(/[&?]name=\w+/, '&name=orig');
                
                images.push({
                    url: originalUrl,
                    tweetId,
                    username,
                    index
                });
            });
        });
        
        return images;
      }, this.currentUsername);
      
      this.logger.info(`Extracted ${imageData.length} image URLs from ${this.currentUsername}'s media`);
      return imageData;
    } catch (error) {
      throw new ScraperError(
        `Failed to extract image URLs: ${(error as Error).message}`,
        ScraperErrorType.SCRAPING_ERROR
      );
    }
  }
  
  /**
   * Download extracted images with concurrent batch uploading
   * @param imageDataList Array of image data to download
   * @returns Object containing download statistics and upload results
   */
  public async downloadImages(imageDataList: ImageData[]): Promise<{
    stats: {
      successful: number;
      failed: number;
      skipped: number;
      total: number;
    };
    downloadedPaths: string[];
    uploadResults?: UploadResult[];
    totalUploadStats?: UploadResult;
  }> {
    if (imageDataList.length === 0) {
      this.logger.warn(`No images to download for ${this.currentUsername}`);
      return { 
        stats: { successful: 0, failed: 0, skipped: 0, total: 0 },
        downloadedPaths: []
      };
    }
    
    this.logger.info(`Starting download of ${imageDataList.length} images for ${this.currentUsername}`);
    
    // Create user-specific directory if it doesn't exist
    const userDir = path.join(this.config.downloadPath, this.currentUsername);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    // Reset the downloaded paths array for this batch
    this.downloadedImagePaths = [];
    
    // Check if Google Drive upload is enabled
    const isUploadEnabled = this.config.googleDrive?.enableUpload && this.googleDriveUploader;
    
    // Create progress bar for downloads
    const downloadProgressId = `download-${this.currentUsername}`;
    this.progressLogger.createProgressBar(
      downloadProgressId,
      imageDataList.length,
      'Downloading',
      this.currentUsername
    );
    
    try {
      // Use batch downloading to process images efficiently
      // Break into chunks of 20 images for better tracking
      const BATCH_SIZE = 20;
      let successful = 0;
      let failed = 0;
      let skipped = 0;
      
      // Prepare arrays for tracking
      const downloadedPaths: string[] = [];
      const uploadBatches: string[][] = [];
      let currentUploadBatch: string[] = [];
      
      // Process in batches for better memory management
      for (let i = 0; i < imageDataList.length; i += BATCH_SIZE) {
        const batch = imageDataList.slice(i, i + BATCH_SIZE);
        
        // Process this batch concurrently
        const batchResults = await Promise.allSettled(
          batch.map(imageData => this.imageDownloader.downloadImage(imageData))
        );
        
        // Count results and collect paths
        batchResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            successful++;
            downloadedPaths.push(result.value);
            this.downloadedImagePaths.push(result.value);
            
            // Add to current upload batch
            currentUploadBatch.push(result.value);
            if (currentUploadBatch.length >= (this.config.uploadBatchSize || 10)) {
              uploadBatches.push([...currentUploadBatch]);
              currentUploadBatch = [];
            }
          } else {
            const error = result.reason;
            if (error instanceof ScraperError && error.type === ScraperErrorType.DOWNLOAD_ERROR) {
              failed++;
              const actualIndex = i + index;
              this.progressLogger.error(
                `Failed to download image ${actualIndex + 1}/${imageDataList.length}`,
                error
              );
            } else {
              skipped++;
            }
          }
        });
        
        // Update the progress bar
        this.progressLogger.updateProgress(downloadProgressId, successful);
        
        // Log progress
        this.progressLogger.info(
          `Progress: ${successful}/${imageDataList.length} images (${failed} failed, ${skipped} skipped)`,
          downloadProgressId,
          successful
        );
      }
      
      // Add any remaining images to the upload batches
      if (currentUploadBatch.length > 0) {
        uploadBatches.push(currentUploadBatch);
      }
      
      // Complete the progress bar
      this.progressLogger.completeProgress(
        downloadProgressId,
        `Downloaded ${successful}/${imageDataList.length} images for ${this.currentUsername}`
      );
      
      // If Google Drive uploads are enabled, process uploads
      if (isUploadEnabled && downloadedPaths.length > 0) {
        return await this.processUploads(uploadBatches, {
          successful,
          failed,
          skipped,
          total: imageDataList.length
        }, downloadedPaths);
      } else {
        this.progressLogger.success(
          `Completed downloading images for ${this.currentUsername}: ` +
          `${successful} successful, ${failed} failed, ${skipped} skipped`
        );
        
        return { 
          stats: { successful, failed, skipped, total: imageDataList.length },
          downloadedPaths
        };
      }
    } catch (error) {
      this.progressLogger.error(`Download process failed for ${this.currentUsername}`, error as Error);
      
      // Return partial results if any
      const stats = this.imageDownloader.getStats();
      return {
        stats,
        downloadedPaths: this.downloadedImagePaths
      };
    }
  }
  
  /**
   * Process uploads in batches after downloads complete
   * @param uploadBatches Batches of file paths to upload
   * @param downloadStats Download statistics
   * @param allDownloadedPaths All downloaded file paths
   * @returns Promise resolving to combined results
   */
  private async processUploads(
    uploadBatches: string[][],
    downloadStats: { successful: number, failed: number, skipped: number, total: number },
    allDownloadedPaths: string[]
  ): Promise<{
    stats: typeof downloadStats,
    downloadedPaths: string[],
    uploadResults: UploadResult[],
    totalUploadStats: UploadResult
  }> {
    const uploadPromises: Promise<UploadResult>[] = [];
    const uploadResults: UploadResult[] = [];
    
    // Maximum number of concurrent uploads
    const MAX_CONCURRENT = this.config.maxConcurrentUploads || 3;
    
    // Create a semaphore to limit concurrent uploads
    const uploadSemaphore = new Semaphore(MAX_CONCURRENT);
    
    // Queue up each batch for upload with semaphore control
    uploadBatches.forEach((batch, index) => {
      uploadPromises.push(
        uploadSemaphore.execute(async () => {
          const result = await this.uploadBatchAsync(batch, index + 1);
          uploadResults.push(result);
          return result;
        })
      );
    });
    
    // Wait for all uploads to complete
    await Promise.allSettled(uploadPromises);
    
    // Calculate total upload statistics
    const totalUploadStats = this.combineUploadResults(uploadResults);
    
    this.progressLogger.success(
      `Completed processing ${this.currentUsername}: ${downloadStats.successful}/${downloadStats.total} downloaded, ` +
      `${totalUploadStats.successful}/${totalUploadStats.total} uploaded`
    );
    
    return {
      stats: downloadStats,
      downloadedPaths: allDownloadedPaths,
      uploadResults,
      totalUploadStats
    };
  }
  
  /**
   * Get download statistics
   * @returns Current download statistics
   */
  public getDownloadStats() {
    return this.imageDownloader.getStats();
  }
  
  /**
   * Check if an account is private
   * @returns true if the account is private
   */
  public async isPrivateAccount(): Promise<boolean> {
    const isPrivate = await this.privateAccountLocator.isVisible();
    if (isPrivate) {
      this.logger.warn(`Account @${this.currentUsername} is private`);
    }
    return isPrivate;
  }
  
  /**
   * Check if an account is suspended
   * @returns true if the account is suspended
   */
  public async isSuspendedAccount(): Promise<boolean> {
    const isSuspended = await this.suspendedAccountLocator.isVisible();
    if (isSuspended) {
      this.logger.warn(`Account @${this.currentUsername} is suspended`);
    }
    return isSuspended;
  }
  
  /**
   * Get media tab locator for a specific user
   * @param username Twitter username
   * @returns Locator for the media tab
   */
  private getMediaTabLocator(username: string) {
    return this.page.locator(`a[href="/${username}/media"]`);
  }
  
  /**
   * Helper method to find tweet containers using multiple selectors
   * @returns A locator that matches tweet containers
   */
  private getTweetContainerLocator(): any {
    return [
      this.tweetLocator,
      this.cellDivLocator,
      this.page.locator('[data-testid*="tweet"]')
    ];
  }
  
  /**
   * Clean up old files based on retention policy
   * @param daysToKeep Number of days to keep files (default: 3)
   */
  public async cleanupOldFiles(daysToKeep: number = 3): Promise<void> {
    try {
      this.logger.info(`Starting cleanup of files older than ${daysToKeep} days`);
      await FileCleanup.cleanupOldFiles(this.config.downloadPath, daysToKeep);
    } catch (error) {
      this.logger.error('File cleanup failed', error as Error);
      // Continue execution - cleanup failure shouldn't halt the scraping process
    }
  }
  
  /**
   * Upload a batch of images asynchronously
   * @param filePaths Array of file paths to upload
   * @param batchNumber The batch number for logging purposes
   * @returns Promise resolving to upload result statistics
   */
  private async uploadBatchAsync(
    filePaths: string[], 
    batchNumber: number
  ): Promise<UploadResult> {
    try {
      if (!this.googleDriveUploader || filePaths.length === 0) {
        return { successful: 0, failed: 0, skipped: 0, total: 0 };
      }
      
      // Create a unique ID for this upload batch
      const uploadProgressId = `upload-${this.currentUsername}-batch${batchNumber}`;
      
      // Create a progress bar for this upload batch
      this.progressLogger.createProgressBar(
        uploadProgressId,
        filePaths.length,
        'Uploading',
        `${this.currentUsername} B${batchNumber}`
      );
      
      this.progressLogger.info(`Starting async upload of batch ${batchNumber} (${filePaths.length} files) for ${this.currentUsername}`);
      const result = await this.googleDriveUploader.batchUpload(filePaths, this.currentUsername, uploadProgressId);
      
      this.progressLogger.completeProgress(
        uploadProgressId,
        `Batch ${batchNumber} upload completed for @${this.currentUsername}: ${result.successful}/${result.total} files`
      );
      
      this.progressLogger.success(
        `Batch ${batchNumber} upload completed for ${this.currentUsername}: ` +
        `${result.successful}/${result.total} successful, ${result.failed} failed, ${result.skipped} skipped`
      );
      
      return result;
    } catch (error) {
      this.progressLogger.error(`Batch ${batchNumber} upload failed`, error as Error);
      return { 
        successful: 0, 
        failed: filePaths.length, 
        skipped: 0, 
        total: filePaths.length 
      };
    }
  }
  
  /**
   * Combine multiple upload results into a single aggregated result
   * @param results Array of upload results
   * @returns Combined upload statistics
   */
  private combineUploadResults(results: UploadResult[]): UploadResult {
    return results.reduce(
      (acc, curr) => ({
        successful: acc.successful + curr.successful,
        failed: acc.failed + curr.failed,
        skipped: acc.skipped + curr.skipped,
        total: acc.total + curr.total
      }),
      { successful: 0, failed: 0, skipped: 0, total: 0 }
    );
  }
  
  /**
   * Download images with concurrent batch uploading
   * @param imageDataList Array of image data to download
   * @returns Statistics and results of download and upload operations
   */
  private async downloadWithConcurrentUpload(
    imageDataList: ImageData[]
  ): Promise<{
    stats: {
      successful: number;
      failed: number;
      skipped: number;
      total: number;
    };
    downloadedPaths: string[];
    uploadResults: UploadResult[];
    totalUploadStats: UploadResult;
  }> {
    if (imageDataList.length === 0) {
      return { 
        stats: { successful: 0, failed: 0, skipped: 0, total: 0 },
        downloadedPaths: [],
        uploadResults: [],
        totalUploadStats: { successful: 0, failed: 0, skipped: 0, total: 0 }
      };
    }
    
    // Get batch configuration from settings
    const UPLOAD_BATCH_SIZE = this.config.uploadBatchSize || 10;
    const MAX_CONCURRENT_UPLOADS = this.config.maxConcurrentUploads || 3;
    
    // Set up tracking variables
    let downloadedBatch: string[] = [];
    const allDownloadedPaths: string[] = [];
    const uploadPromises: Promise<UploadResult>[] = [];
    const uploadResults: UploadResult[] = [];
    const uploadQueue: { paths: string[], batchNumber: number }[] = [];
    let activeUploads = 0;
    let batchCounter = 1;
    
    // Create progress bar for downloads
    const downloadProgressId = `download-${this.currentUsername}`;
    this.progressLogger.createProgressBar(
      downloadProgressId, 
      imageDataList.length, 
      'Downloading', 
      this.currentUsername
    );
    
    // Track download stats
    let successful = 0;
    let failed = 0;
    let skipped = 0;
    let totalUploaded = 0;
    
    // Process queue function to manage concurrent uploads
    const processQueue = async () => {
      // While we have capacity and items in the queue
      while (activeUploads < MAX_CONCURRENT_UPLOADS && uploadQueue.length > 0) {
        const batch = uploadQueue.shift()!;
        activeUploads++;
        
        // Start the upload and add to promises array
        uploadPromises.push(
          this.uploadBatchAsync(batch.paths, batch.batchNumber)
            .then(result => {
              // Process completed upload
              uploadResults.push(result);
              totalUploaded += result.successful;
              
              // Log overall progress
              this.progressLogger.info(
                `Progress: ${successful}/${imageDataList.length} downloaded, ` +
                `${totalUploaded} uploaded across ${uploadResults.length} completed batches`,
                downloadProgressId,
                successful
              );
              
              // Decrease active count and process next in queue
              activeUploads--;
              return processQueue().then(() => result);
            })
        );
      }
    };
    
    // Download each image with rate limiting
    for (let i = 0; i < imageDataList.length; i++) {
      const imageData = imageDataList[i];
      
      try {
        // Download the image and get the local path
        const localPath = await this.imageDownloader.downloadImage(imageData);
        successful++;
        
        // Update progress bar
        this.progressLogger.updateProgress(downloadProgressId, successful);
        
        // Track downloaded path
        if (localPath) {
          downloadedBatch.push(localPath);
          allDownloadedPaths.push(localPath);
        }
        
        // When we reach the batch size or the end, queue up an upload
        if (downloadedBatch.length >= UPLOAD_BATCH_SIZE || i === imageDataList.length - 1) {
          // Only process if we have files to upload and Google Drive is enabled
          if (downloadedBatch.length > 0 && this.googleDriveUploader) {
            // Create a copy of the current batch
            const currentBatch = [...downloadedBatch];
            
            // Add to the upload queue
            uploadQueue.push({
              paths: currentBatch,
              batchNumber: batchCounter++
            });
            
            // Process the queue (will start uploads if we have capacity)
            await processQueue();
            
            // Reset the batch
            downloadedBatch = [];
          }
        }
        
        // Log download progress periodically
        if (successful % 10 === 0 || successful === imageDataList.length) {
          this.progressLogger.info(
            `Downloaded ${successful}/${imageDataList.length} images for ${this.currentUsername} ` +
            `(${uploadResults.length} batches uploaded, ${uploadQueue.length} pending, ${activeUploads} active)`,
            downloadProgressId,
            successful
          );
        }
      } catch (error) {
        if ((error as ScraperError).type === ScraperErrorType.DOWNLOAD_ERROR) {
          failed++;
          this.progressLogger.error(`Failed to download image ${i + 1}/${imageDataList.length}`, error as Error);
        } else {
          // If it was skipped due to existing file
          skipped++;
        }
      }
      
      // Apply rate limiting delay between downloads
      if (i < imageDataList.length - 1) {
        await this.wait(this.config.rateLimitDelay);
      }
    }
    
    // Handle any remaining batches in the queue
    while (uploadQueue.length > 0 || activeUploads > 0) {
      await processQueue();
      
      // Small delay to prevent tight looping
      if (activeUploads > 0) {
        await this.wait(500);
      }
    }
    
    // Wait for all upload operations to complete
    await Promise.allSettled(uploadPromises);
    
    // Combine all upload results
    const totalUploadStats = this.combineUploadResults(uploadResults);
    
    // Complete the download progress bar
    this.progressLogger.completeProgress(
      downloadProgressId,
      `Downloaded ${successful}/${imageDataList.length} images for @${this.currentUsername}`
    );
    
    this.progressLogger.success(
      `Completed downloading images for ${this.currentUsername}: ` +
      `${successful} downloaded successfully, ${failed} download failures, ${skipped} skipped`
    );
    
    this.progressLogger.success(
      `All uploads completed for ${this.currentUsername}: ` +
      `${totalUploadStats.successful} uploaded successfully, ${totalUploadStats.failed} upload failures, ${totalUploadStats.skipped} skipped`
    );
    
    return { 
      stats: { successful, failed, skipped, total: imageDataList.length },
      downloadedPaths: allDownloadedPaths,
      uploadResults,
      totalUploadStats
    };
  }
  
  /**
   * Extract image URLs only without downloading (for concurrent processing)
   * @param username Twitter username to extract images from
   * @returns Array of image data objects
   */
  public async extractImageUrlsOnly(username: string): Promise<ImageData[]> {
    try {
      await this.navigateToProfileMediaTab(username);
      
      // Check if account is private or suspended
      if (await this.isPrivateAccount() || await this.isSuspendedAccount()) {
        return [];
      }
      
      await this.scrollAndLoadMedia();
      return await this.extractImageUrls();
    } catch (error) {
      this.logger.error(`Error extracting image URLs for @${username}`, error as Error);
      throw error;
    }
  }
  
  /**
   * Download images from pre-extracted data (for concurrent processing)
   * @param extractedData Array of image data objects
   * @param username Twitter username
   * @returns Download result
   */
  public async downloadFromExtractedData(
    extractedData: ImageData[],
    username: string
  ): Promise<{ 
    stats: { successful: number; failed: number; skipped: number; total: number; }; 
    downloadedPaths: string[];
    uploadResults?: UploadResult[];
    totalUploadStats?: UploadResult;
  }> {
    // Set the current username for proper path organization
    this.currentUsername = username;
    
    // Use the existing download method
    return await this.downloadImages(extractedData);
  }
}
