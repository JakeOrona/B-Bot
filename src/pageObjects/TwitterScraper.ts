/**
 * TwitterScraper: Core class for scraping images from Twitter/X profiles
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { ImageData, ScraperConfig, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import { ImageDownloader } from '../utilities/ImageDownloader';
import fs from 'fs';
import path from 'path';

export class TwitterScraper extends BasePage {
  private config: ScraperConfig;
  private imageDownloader: ImageDownloader;
  private currentUsername: string = '';
  
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
  }
  
  // Profile and navigation locators
  private readonly emptyStateLocator = this.page.locator('div[data-testid="emptyState"]');
  
  // Media and tweet locators
  private readonly tweetPhotoLocator = this.page.locator('[data-testid="tweetPhoto"]');
  private readonly tweetLocator = this.page.locator('article[data-testid="tweet"]');
  
  // Account status locators
  private readonly privateAccountLocator = this.page.locator('span:has-text("These posts are protected")');
  private readonly suspendedAccountLocator = this.page.locator('span:has-text("Account suspended")');
  
  /**
   * Navigate to a Twitter profile
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
      
      this.logger.info(`Starting to scroll and load media for ${this.currentUsername}`);
      
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
        
        // Log progress
        if (scrollCount % 5 === 0) {
          this.logger.info(`Scrolled ${scrollCount}/${maxScrolls} times`);
        }
      }
      
      // Count the number of images found
      const imageCount = await this.page.evaluate(() => {
        const images = document.querySelectorAll('[data-testid="tweetPhoto"]');
        return images.length;
      });
      
      this.logger.info(`Found ${imageCount} images after scrolling ${scrollCount} times`);
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
        
        // Select all tweet containers with images
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        
        tweets.forEach((tweet) => {
          // Get the tweet ID from the time element's link
          const timeElement = tweet.querySelector('time');
          if (!timeElement) return;
          
          const linkElement = timeElement.closest('a');
          if (!linkElement) return;
          
          const href = linkElement.getAttribute('href');
          if (!href) return;
          
          // Extract the tweet ID from the link href (e.g., /username/status/1234567890)
          const match = href.match(/\/status\/(\d+)/);
          if (!match) return;
          
          const tweetId = match[1];
          
          // Get all image elements in the tweet
          const imageElements = tweet.querySelectorAll('[data-testid="tweetPhoto"] img');
          
          // Extract image URLs
          Array.from(imageElements).forEach((img, index) => {
            const src = img.getAttribute('src');
            if (!src) return;
            
            // Get the largest version of the image by modifying the URL
            // Twitter usually stores images with size parameters, we want to get the original size
            const originalUrl = src.replace(/&name=\w+$/, '&name=orig');
            
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
   * Download extracted images
   * @param imageDataList Array of image data to download
   * @param username Twitter username
   * @returns Object containing download statistics
   */
  public async downloadImages(imageDataList: ImageData[]): Promise<{
    successful: number;
    failed: number;
    skipped: number;
    total: number;
  }> {
    if (imageDataList.length === 0) {
      this.logger.warn(`No images to download for ${this.currentUsername}`);
      return { successful: 0, failed: 0, skipped: 0, total: 0 };
    }
    
    this.logger.info(`Starting download of ${imageDataList.length} images for ${this.currentUsername}`);
    
    // Create user-specific directory if it doesn't exist
    const userDir = path.join(this.config.downloadPath, this.currentUsername);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    // Download each image with rate limiting
    let successful = 0;
    let failed = 0;
    let skipped = 0;
    
    for (let i = 0; i < imageDataList.length; i++) {
      const imageData = imageDataList[i];
      
      try {
        // Download the image
        await this.imageDownloader.downloadImage(imageData);
        successful++;
        
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
    
    return { successful, failed, skipped, total: imageDataList.length };
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
}
