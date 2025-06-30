/**
 * TwitterScraper: Core class for scraping images from Twitter/X profiles
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { ImageData, ScraperConfig, ScraperError, ScraperErrorType, MediaData, VideoData } from '../interfaces/ScraperTypes';
import { ImageDownloader } from '../utilities/ImageDownloader';
import { GoogleDriveUploader } from '../utilities/GoogleDriveUploader';
import { FileCleanup } from '../utilities/FileCleanup';
import fs from 'fs';
import path from 'path';

export class TwitterScraper extends BasePage {
  private config: ScraperConfig;
  private imageDownloader: ImageDownloader;
  private googleDriveUploader?: GoogleDriveUploader;
  private currentUsername: string = '';
  private downloadedImagePaths: string[] = [];
  private workerId?: number;
  private contextArtist?: string;
  
  /**
   * Constructor for TwitterScraper
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   * @param config Scraper configuration
   */
  constructor(
    page: Page,
    context: BrowserContext,
    browser: Browser,
    config: ScraperConfig
  ) {
    super(page, context, browser);
    this.config = config;
    this.imageDownloader = new ImageDownloader(config.downloadPath);
    
    // Initialize Google Drive uploader if enabled
    if (config.googleDrive?.enableUpload && config.googleDrive?.rootFolderId) {
      try {
        this.googleDriveUploader = new GoogleDriveUploader(
          config.googleDrive.credentialsPath,
          config.googleDrive.rootFolderId
        );
        this.logger.info('Google Drive integration enabled');
      } catch (error) {
        this.logger.error('Failed to initialize Google Drive uploader', error as Error);
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
  public async scrollAndLoadMedia(maxScrolls: number = this.config.maxScrolls): Promise<number> {
      try {
          let previousHeight = 0;
          let scrollCount = 0;
          let sameHeightCount = 0;
          
          const logPrefix = this.workerId ? `Worker ${this.workerId}` : '';
          const artistName = this.contextArtist || this.currentUsername;
          
          this.logger.info(`${logPrefix ? logPrefix + ': ' : ''}Starting to scroll and load media for ${artistName}`);
          
          while (scrollCount < maxScrolls && sameHeightCount < 10) {
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
              
              // Log progress with worker and artist context
              if (scrollCount % 5 === 0) {
                  this.logger.info(`${logPrefix ? logPrefix + ': ' : ''}${artistName} scrolled ${scrollCount}/${maxScrolls} times`);
              }
          }
          
          // Count the number of images found using updated selector for Twitter media images
          const imageCount = await this.page.evaluate(() => {
              const images = document.querySelectorAll('img[src*="pbs.twimg.com"]');
              console.log(`Twitter media images found during scroll: ${images.length}`);
              return images.length;
          });
          
          this.logger.info(`${logPrefix ? logPrefix + ': ' : ''}Found ${imageCount} images after scrolling ${scrollCount} times for ${artistName}`);
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
   * Extract both images and videos from the current page
   * @returns Combined media data
   */
  public async extractAllMedia(): Promise<MediaData> {
      try {
          this.logger.info(`Extracting all media from ${this.currentUsername}'s timeline`);
          
          // Extract images using existing method
          const images = await this.extractImageUrls();
          
          // Extract videos using new method
          const videos = await this.extractVideoUrls();
          
          this.logger.info(`Found ${images.length} images and ${videos.length} videos`);
          
          return { images, videos };
      } catch (error) {
          throw new ScraperError(
              `Failed to extract media: ${(error as Error).message}`,
              ScraperErrorType.SCRAPING_ERROR
          );
      }
  }

/**
 * Extract video URLs from the current page
 * @returns Array of video data objects
 */
public async extractVideoUrls(): Promise<VideoData[]> {
    try {
        this.logger.info(`Extracting video URLs from ${this.currentUsername}'s media`);
        
        const videoData = await this.page.evaluate((username) => {
            const videos: Array<{url: string, tweetId: string, username: string, index: number, type: 'mp4' | 'gif' | 'm3u8', thumbnail?: string}> = [];
            
            // Look for video indicators in tweets
            const tweets = document.querySelectorAll('article[data-testid="tweet"], div[data-testid="cellInnerDiv"]');
            
            tweets.forEach((tweet, tweetIndex) => {
                // Extract tweet ID
                let tweetId = 'unknown';
                const linkElement = tweet.querySelector('a[href*="/status/"]');
                if (linkElement) {
                    const href = linkElement.getAttribute('href');
                    const match = href?.match(/\/status\/(\d+)/);
                    if (match) tweetId = match[1];
                }
                
                // Look for actual video elements with src attributes
                const videoElements = tweet.querySelectorAll('video[src]');
                videoElements.forEach((video, index) => {
                    const src = video.getAttribute('src');
                    if (src && src.includes('video.twimg.com')) {
                        videos.push({
                            url: src,
                            tweetId,
                            username,
                            index: videos.length,
                            type: src.includes('.gif') ? 'gif' : 'mp4'
                        });
                    }
                });
              });
            console.log(`Total video placeholders found: ${videos.length}`);
            return videos;
        }, this.currentUsername);
        
        this.logger.info(`Found ${videoData.length} video indicators`);
        
        // Try to resolve actual video URLs
        const resolvedVideos = await this.resolveVideoUrls(videoData);
        
        this.logger.info(`Extracted ${resolvedVideos.length} video URLs`);
        return resolvedVideos;
    } catch (error) {
        throw new ScraperError(
            `Failed to extract video URLs: ${(error as Error).message}`,
            ScraperErrorType.SCRAPING_ERROR
        );
    }
}

  /**
   * Resolve video IDs to actual downloadable URLs
   */
  private async resolveVideoUrls(videoData: VideoData[]): Promise<VideoData[]> {
      const resolvedVideos: VideoData[] = [];
      
      for (const video of videoData) {
          if (video.url.startsWith('GIF_PLACEHOLDER:') || video.url.startsWith('VIDEO_PLACEHOLDER:')) {
              // Skip placeholders that can't be resolved
              this.logger.warn(`Skipping unresolved video placeholder: ${video.url}`);
              continue;
          } else {
              // URL is already resolved
              resolvedVideos.push(video);
          }
      }
      
      return resolvedVideos;
  }

  /**
   * Find working video URL for a given video ID using network interception
   * @param videoId The video ID to resolve
   * @returns Working video URL or null
   */
  private async findWorkingVideoUrl(videoId: string): Promise<string | null> {
      try {
          // Set up network interception to catch video requests
          const videoUrls: string[] = [];
          
          const responseHandler = (response: any) => {
              const url = response.url();
              if (url.includes('video.twimg.com') && 
                  (url.includes('.mp4') || url.includes('.m3u8')) &&
                  url.includes(videoId)) {
                  videoUrls.push(url);
              }
          };
          
          this.page.on('response', responseHandler);
          
          // Try to trigger video loading by clicking on video area
          const videoSelectors = [
              `img[src*="${videoId}"]`,
              `div[data-testid="videoPlayer"]`,
              `video[poster*="${videoId}"]`
          ];
          
          for (const selector of videoSelectors) {
              try {
                  const element = await this.page.locator(selector).first();
                  if (await element.isVisible()) {
                      await element.click();
                      await this.wait(1000); // Wait for network requests
                      break;
                  }
              } catch (error) {
                  // Continue to next selector
              }
          }
          
          // Clean up event listener
          this.page.off('response', responseHandler);
          
          // Return the best quality URL found
          if (videoUrls.length > 0) {
              // Prefer MP4 over m3u8, and higher quality
              const mp4Urls = videoUrls.filter(url => url.includes('.mp4'));
              if (mp4Urls.length > 0) {
                  // Sort by quality (higher resolution first)
                  mp4Urls.sort((a, b) => {
                      const aRes = this.extractResolution(a);
                      const bRes = this.extractResolution(b);
                      return bRes - aRes;
                  });
                  return mp4Urls[0];
              }
              return videoUrls[0];
          }
          
          return null;
      } catch (error) {
          this.logger.warn(`Failed to resolve video URL for ${videoId}: ${(error as Error).message}`);
          return null;
      }
  }

  /**
   * Extract resolution number from video URL for sorting
   * @param url Video URL
   * @returns Resolution as number (e.g., 1080 for 1080p)
   */
  private extractResolution(url: string): number {
      const match = url.match(/(\d+)x\d+/);
      return match ? parseInt(match[1]) : 0;
  }
  
  /**
   * Download extracted images
   * @param imageDataList Array of image data to download
   * @param username Twitter username
   * @returns Object containing download statistics
   */
  public async downloadImages(imageDataList: ImageData[]): Promise<{
    stats: {
      successful: number;
      failed: number;
      skipped: number;
      total: number;
    };
    downloadedPaths: string[];
  }> {
    if (imageDataList.length === 0) {
      this.logger.warn(`No images to download for ${this.currentUsername}`);
      return { 
        stats: { successful: 0, failed: 0, skipped: 0, total: 0 },
        downloadedPaths: []
      };
    }
    
    this.logger.info(`Starting download of ${imageDataList.length} images for ${this.currentUsername}`);
    
    // Log sample of found image URLs for debugging
    if (imageDataList.length > 0) {
      const sampleUrl = imageDataList[0].url;
      this.logger.info(`Sample image URL: ${sampleUrl}`);
    }
    
    // Create user-specific directory if it doesn't exist
    const userDir = path.join(this.config.downloadPath, this.currentUsername);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    // Reset the downloaded paths array for this batch
    this.downloadedImagePaths = [];
    
    // Download each image with rate limiting
    let successful = 0;
    let failed = 0;
    let skipped = 0;
    
    for (let i = 0; i < imageDataList.length; i++) {
      const imageData = imageDataList[i];
      
      try {
        // Download the image and get the local path
        const localPath = await this.imageDownloader.downloadImage(imageData);
        successful++;
        
        // Track downloaded path for later batch upload
        if (localPath) {
          this.downloadedImagePaths.push(localPath);
        }
        
        // Log progress periodically
        if (successful % 10 === 0 || successful === imageDataList.length) {
          this.logger.info(`Downloaded ${successful}/${imageDataList.length} images for ${this.currentUsername}`);
        }
      } catch (error) {
        if ((error as ScraperError).type === ScraperErrorType.DOWNLOAD_ERROR) {
          failed++;
          this.logger.error(`Failed to download image ${i + 1}/${imageDataList.length}`, error as Error);
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
    
    this.logger.success(
      `Completed downloading images for ${this.currentUsername}: ` +
      `${successful} successful, ${failed} failed, ${skipped} skipped`
    );
    
    // Upload to Google Drive if enabled
    if (this.config.googleDrive?.enableUpload && this.googleDriveUploader && this.downloadedImagePaths.length > 0) {
      this.logger.info(`Starting batch upload of ${this.downloadedImagePaths.length} images to Google Drive`);
      try {
        const uploadResult = await this.googleDriveUploader.batchUpload(this.downloadedImagePaths, this.currentUsername);
        this.logger.success(`Google Drive upload completed: ${uploadResult.successful}/${uploadResult.total} successful`);
      } catch (error) {
        this.logger.error('Google Drive upload failed', error as Error);
        // Continue execution - upload failure shouldn't halt the scraping process
      }
    }
    
    return { 
      stats: { successful, failed, skipped, total: imageDataList.length },
      downloadedPaths: this.downloadedImagePaths
    };
  }

  /**
   * Download all media (images and videos)
   * @param mediaData Combined media data to download
   * @returns Download statistics
   */
  public async downloadAllMedia(mediaData: MediaData): Promise<{
      imageStats: { successful: number; failed: number; skipped: number; total: number };
      videoStats: { successful: number; failed: number; skipped: number; total: number };
      downloadedPaths: string[];
  }> {
      const downloadedPaths: string[] = [];
      
      // Download images
      const imageResult = await this.downloadImages(mediaData.images);
      downloadedPaths.push(...imageResult.downloadedPaths);
      
      // Download videos
      let videoStats = { successful: 0, failed: 0, skipped: 0, total: mediaData.videos.length };
      
      for (const video of mediaData.videos) {
          try {
              const localPath = await this.imageDownloader.downloadVideo(video);
              videoStats.successful++;
              downloadedPaths.push(localPath);
              
              if (videoStats.successful % 5 === 0) {
                  this.logger.info(`Downloaded ${videoStats.successful}/${videoStats.total} videos`);
              }
          } catch (error) {
              videoStats.failed++;
              this.logger.error(`Failed to download video ${video.url}`, error as Error);
          }
          
          // Rate limiting
          await this.wait(this.config.rateLimitDelay);
      }
      
      this.logger.success(
          `Media download complete: ${imageResult.stats.successful} images, ${videoStats.successful} videos`
      );
      
      return {
          imageStats: imageResult.stats,
          videoStats,
          downloadedPaths
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
   * Set worker context for better logging
   * @param workerId Worker ID
   * @param artist Current artist being processed
   */
  public setWorkerContext(workerId: number, artist: string): void {
      this.workerId = workerId;
      this.contextArtist = artist;
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
}
