/**
 * TwitterScraper: Core class for scraping images from Twitter/X profiles
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { ImageData, ScraperConfig, ScraperError, ScraperErrorType, MediaData, MediaType } from '../interfaces/ScraperTypes';
import { MediaDownloader } from '../utilities/MediaDownloader';
import { GoogleDriveUploader } from '../utilities/GoogleDriveUploader';
import { FileCleanup } from '../utilities/FileCleanup';
import fs from 'fs';
import path from 'path';

export class TwitterScraper extends BasePage {
  private config: ScraperConfig;
  private mediaDownloader: MediaDownloader;
  private googleDriveUploader?: GoogleDriveUploader;
  private currentUsername: string = '';
  private downloadedMediaPaths: string[] = [];
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
    this.mediaDownloader = new MediaDownloader(config.downloadPath);
    
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
   * Extract media URLs from the current page (images, videos, GIFs)
   * @returns Array of media data objects
   */
  public async extractMediaUrls(): Promise<MediaData[]> {
    try {
      this.logger.info(`Extracting media URLs from ${this.currentUsername}'s media`);
      
      // For complex operations like this where we need to extract data from the DOM,
      // we need to use page.evaluate to perform DOM manipulation directly
      const mediaData = await this.page.evaluate((username) => {
        const media: {url: string, tweetId: string, username: string, index: number, mediaType: string}[] = [];
        
        // Debug: Log what we're finding
        const allImages = document.querySelectorAll('img');
        const allVideos = document.querySelectorAll('video');
        const twitterImages = document.querySelectorAll('img[src*="pbs.twimg.com"]');
        const twitterVideos = document.querySelectorAll('video[src*="video.twimg.com"], video source[src*="video.twimg.com"]');
        
        console.log(`Total images found: ${allImages.length}`);
        console.log(`Total videos found: ${allVideos.length}`);
        console.log(`Twitter media images found: ${twitterImages.length}`);
        console.log(`Twitter media videos found: ${twitterVideos.length}`);
        
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
            console.log('No tweet containers found. Falling back to direct media extraction.');
            
            // Extract images directly
            const directImages = document.querySelectorAll('img[src*="pbs.twimg.com"]');
            Array.from(directImages).forEach((img, index) => {
                const src = (img as HTMLImageElement).getAttribute('src');
                if (!src) return;
                
                // Determine if this is a GIF or regular image
                const isGif = src.includes('format=gif') || src.includes('.gif') || 
                              (img as HTMLImageElement).alt?.toLowerCase().includes('gif');
                
                // Get the largest version of the image by modifying the URL
                const originalUrl = src.replace(/[&?]name=\w+/, '&name=orig');
                
                media.push({
                    url: originalUrl,
                    tweetId: `unknown-${Date.now()}-${index}`,
                    username,
                    index,
                    mediaType: isGif ? 'gif' : 'image'
                });
            });
            
            // Extract videos directly
            const directVideos = document.querySelectorAll('video');
            Array.from(directVideos).forEach((video, index) => {
                // Try to get video source from different attributes
                let videoUrl = (video as HTMLVideoElement).src;
                
                if (!videoUrl) {
                    // Check source elements within video
                    const sourceElement = video.querySelector('source');
                    if (sourceElement) {
                        videoUrl = sourceElement.getAttribute('src') || '';
                    }
                }
                
                if (!videoUrl) {
                    // Check data attributes that might contain video URL
                    videoUrl = (video as HTMLElement).getAttribute('data-src') || 
                              (video as HTMLElement).getAttribute('data-video-url') || '';
                }
                
                if (videoUrl && (videoUrl.includes('video.twimg.com') || videoUrl.includes('pbs.twimg.com'))) {
                    media.push({
                        url: videoUrl,
                        tweetId: `video-unknown-${Date.now()}-${index}`,
                        username,
                        index: media.length,
                        mediaType: 'video'
                    });
                }
            });
            
            return media;
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
            
            let mediaIndex = 0;
            
            // Extract images from the tweet
            const imageElements = tweet.querySelectorAll('img[src*="pbs.twimg.com"]');
            Array.from(imageElements).forEach((img) => {
                const src = (img as HTMLImageElement).getAttribute('src');
                if (!src) return;
                
                // Determine if this is a GIF or regular image
                const isGif = src.includes('format=gif') || src.includes('.gif') || 
                              (img as HTMLImageElement).alt?.toLowerCase().includes('gif');
                
                // Get the largest version by modifying the URL
                const originalUrl = src.replace(/[&?]name=\w+/, '&name=orig');
                
                media.push({
                    url: originalUrl,
                    tweetId,
                    username,
                    index: mediaIndex++,
                    mediaType: isGif ? 'gif' : 'image'
                });
            });
            
            // Extract videos from the tweet
            const videoElements = tweet.querySelectorAll('video');
            Array.from(videoElements).forEach((video) => {
                // Try to get video source from different attributes
                let videoUrl = (video as HTMLVideoElement).src;
                
                if (!videoUrl) {
                    // Check source elements within video
                    const sourceElement = video.querySelector('source');
                    if (sourceElement) {
                        videoUrl = sourceElement.getAttribute('src') || '';
                    }
                }
                
                if (!videoUrl) {
                    // Check data attributes
                    videoUrl = (video as HTMLElement).getAttribute('data-src') || 
                              (video as HTMLElement).getAttribute('data-video-url') || '';
                }
                
                // Also check for video containers that might have data attributes
                if (!videoUrl) {
                    const videoContainer = video.closest('[data-testid*="video"]') || 
                                          video.closest('.video-container') ||
                                          video.closest('[role="presentation"]');
                    if (videoContainer) {
                        videoUrl = (videoContainer as HTMLElement).getAttribute('data-video-url') || 
                                  (videoContainer as HTMLElement).getAttribute('data-src') || '';
                    }
                }
                
                if (videoUrl && (videoUrl.includes('video.twimg.com') || videoUrl.includes('pbs.twimg.com'))) {
                    // Try to get the highest quality version
                    const highQualityUrl = videoUrl.replace(/\/\d+x\d+\//, '/1920x1080/');
                    
                    media.push({
                        url: highQualityUrl || videoUrl,
                        tweetId,
                        username,
                        index: mediaIndex++,
                        mediaType: 'video'
                    });
                }
            });
            
            // Look for GIF containers that might be displayed as videos
            const gifContainers = tweet.querySelectorAll('[data-testid*="gif"]');
            Array.from(gifContainers).forEach((container) => {
                // Check for video elements within GIF containers
                const gifVideo = container.querySelector('video');
                if (gifVideo) {
                    let gifUrl = (gifVideo as HTMLVideoElement).src;
                    
                    if (!gifUrl) {
                        const sourceElement = gifVideo.querySelector('source');
                        if (sourceElement) {
                            gifUrl = sourceElement.getAttribute('src') || '';
                        }
                    }
                    
                    if (gifUrl) {
                        media.push({
                            url: gifUrl,
                            tweetId,
                            username,
                            index: mediaIndex++,
                            mediaType: 'gif'
                        });
                    }
                }
            });
        });
        
        return media;
      }, this.currentUsername);
      
      // Convert string mediaType back to enum
      const typedMediaData: MediaData[] = mediaData.map(item => ({
        ...item,
        mediaType: item.mediaType as MediaType
      }));
      
      this.logger.info(`Extracted ${typedMediaData.length} media items from ${this.currentUsername}'s media`);
      
      // Log breakdown by type
      const breakdown = typedMediaData.reduce((acc, item) => {
        acc[item.mediaType] = (acc[item.mediaType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      this.logger.info(`Media breakdown: ${JSON.stringify(breakdown)}`);
      
      return typedMediaData;
    } catch (error) {
      throw new ScraperError(
        `Failed to extract media URLs: ${(error as Error).message}`,
        ScraperErrorType.SCRAPING_ERROR
      );
    }
  }

  /**
   * Backward compatibility method for image URL extraction
   * DEPRECATED: Use extractMediaUrls instead
   */
  public async extractImageUrls(): Promise<MediaData[]> {
    const allMedia = await this.extractMediaUrls();
    // Filter to only return images for backward compatibility
    return allMedia.filter(item => item.mediaType === MediaType.IMAGE);
  }

/**
   * Download extracted media (images, videos, GIFs)
   * @param mediaDataList Array of media data to download
   * @param username Twitter username
   * @returns Object containing download statistics and paths
   */
  public async downloadMedia(mediaDataList: MediaData[]): Promise<{
    stats: {
      successful: number;
      failed: number;
      skipped: number;
      total: number;
      byType: {
        images: number;
        videos: number;
        gifs: number;
      };
    };
    downloadedPaths: string[];
  }> {
    if (mediaDataList.length === 0) {
      this.logger.warn(`No media to download for ${this.currentUsername}`);
      return { 
        stats: { 
          successful: 0, 
          failed: 0, 
          skipped: 0, 
          total: 0,
          byType: { images: 0, videos: 0, gifs: 0 }
        },
        downloadedPaths: []
      };
    }
    
    this.logger.info(`Starting download of ${mediaDataList.length} media items for ${this.currentUsername}`);
    
    // Log breakdown by media type
    const typeBreakdown = mediaDataList.reduce((acc, item) => {
      acc[item.mediaType] = (acc[item.mediaType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    this.logger.info(`Media breakdown to download: ${JSON.stringify(typeBreakdown)}`);
    
    // Log sample of found media URLs for debugging
    if (mediaDataList.length > 0) {
      const sampleMedia = mediaDataList[0];
      this.logger.info(`Sample ${sampleMedia.mediaType} URL: ${sampleMedia.url}`);
    }
    
    // Create user-specific directory if it doesn't exist
    const userDir = path.join(this.config.downloadPath, this.currentUsername);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    // Reset the downloaded paths array for this batch
    this.downloadedMediaPaths = [];
    
    // Download each media file with rate limiting
    let successful = 0;
    let failed = 0;
    let skipped = 0;
    const byType = { images: 0, videos: 0, gifs: 0 };
    
    for (let i = 0; i < mediaDataList.length; i++) {
      const mediaData = mediaDataList[i];
      
      try {
        // Download the media and get the local path
        const localPath = await this.mediaDownloader.downloadMedia(mediaData);
        successful++;
        
        // Track by type for successful downloads
        if (mediaData.mediaType === MediaType.IMAGE) byType.images++;
        else if (mediaData.mediaType === MediaType.VIDEO) byType.videos++;
        else if (mediaData.mediaType === MediaType.GIF) byType.gifs++;
        
        // Track downloaded path for later batch upload
        if (localPath) {
          this.downloadedMediaPaths.push(localPath);
        }
        
        // Log progress periodically
        if (successful % 10 === 0 || successful === mediaDataList.length) {
          this.logger.info(`Downloaded ${successful}/${mediaDataList.length} media items for ${this.currentUsername}`);
        }
      } catch (error) {
        if ((error as ScraperError).type === ScraperErrorType.DOWNLOAD_ERROR) {
          failed++;
          this.logger.error(`Failed to download ${mediaData.mediaType} ${i + 1}/${mediaDataList.length}`, error as Error);
        } else {
          // If it was skipped due to existing file
          skipped++;
        }
      }
      
      // Apply rate limiting delay between downloads
      if (i < mediaDataList.length - 1) {
        await this.wait(this.config.rateLimitDelay);
      }
    }
    
    this.logger.success(
      `Completed downloading media for ${this.currentUsername}: ` +
      `${successful} successful, ${failed} failed, ${skipped} skipped`
    );
    
    // Log detailed breakdown
    this.logger.info(`Downloaded by type: ${byType.images} images, ${byType.videos} videos, ${byType.gifs} GIFs`);
    
    // Upload to Google Drive if enabled
    if (this.config.googleDrive?.enableUpload && this.googleDriveUploader && this.downloadedMediaPaths.length > 0) {
      this.logger.info(`Starting batch upload of ${this.downloadedMediaPaths.length} media items to Google Drive`);
      try {
        const uploadResult = await this.googleDriveUploader.batchUpload(this.downloadedMediaPaths, this.currentUsername);
        this.logger.success(`Google Drive upload completed: ${uploadResult.successful}/${uploadResult.total} successful`);
        
        // ADDED: Log storage information if available
        if (uploadResult.storageInfo) {
          this.logger.info(
            `Google Drive Storage: ${uploadResult.storageInfo.formattedUsed} used / ` +
            `${uploadResult.storageInfo.formattedTotal} total (${uploadResult.storageInfo.usedPercentage.toFixed(1)}% full)`
          );
        }
      } catch (error) {
        this.logger.error('Google Drive upload failed', error as Error);
        // Continue execution - upload failure shouldn't halt the scraping process
      }
    }
    
    return { 
      stats: { successful, failed, skipped, total: mediaDataList.length, byType },
      downloadedPaths: this.downloadedMediaPaths
    };
  }

  /**
   * Backward compatibility method for image downloads
   * DEPRECATED: Use downloadMedia instead
   */
  public async downloadImages(mediaDataList: MediaData[]): Promise<{
    stats: {
      successful: number;
      failed: number;
      skipped: number;
      total: number;
      byType: {
        images: number;
        videos: number;
        gifs: number;
      };
    };
    downloadedPaths: string[];
  }> {
    return this.downloadMedia(mediaDataList);
  }

  /**
   * Get download statistics
   * @returns Current download statistics
   */
  public getDownloadStats() {
    return this.mediaDownloader.getStats();
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
