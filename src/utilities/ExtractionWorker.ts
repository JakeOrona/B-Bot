/**
 * ExtractionWorker: Handles the extraction of image URLs from a Twitter profile
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { TwitterScraper } from '../pageObjects/TwitterScraper';
import { ProfileQueue } from './ProfileQueue';
import { ExtractionResult, ExtractionWorkerInterface, ProfileStatus } from '../interfaces/ConcurrentTypes';
import { ScraperConfig, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import { Logger } from './Logger';
import { Semaphore } from './Semaphore';

export class ExtractionWorker implements ExtractionWorkerInterface {
  private page: Page;
  private context: BrowserContext;
  private browser: Browser;
  private config: ScraperConfig;
  private profileQueue: ProfileQueue;
  private isRunning: boolean = false;
  private logger: Logger;
  private twitterScraper: TwitterScraper;
  private currentProfile: string | null = null;

  /**
   * Constructor
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   * @param config Scraper configuration
   * @param profileQueue Queue of profiles to process
   */
  constructor(
    page: Page,
    context: BrowserContext,
    browser: Browser,
    config: ScraperConfig,
    profileQueue: ProfileQueue
  ) {
    this.page = page;
    this.context = context;
    this.browser = browser;
    this.config = config;
    this.profileQueue = profileQueue;
    this.logger = Logger.getInstance();
    this.twitterScraper = new TwitterScraper(
      page,
      context,
      browser,
      config,
      true // extraction only mode
    );
  }

  /**
   * Start processing profiles from the queue
   */
  public async start(): Promise<void> {
    this.isRunning = true;
    
    try {
      while (this.isRunning) {
        // Get next profile from queue
        const profile = this.profileQueue.getNextWaitingProfile();
        
        if (!profile) {
          // No more profiles to process
          this.logger.info('No more profiles to extract, worker pausing');
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        this.currentProfile = profile.username;
        this.logger.info(`Worker starting extraction for profile @${profile.username}`);
        
        // Update profile status
        this.profileQueue.updateProfileStatus(profile.username, ProfileStatus.EXTRACTING);
        
        try {
          // Extract image URLs
          const extractionResult = await this.extractProfile(profile.username);
          
          if (extractionResult.success && extractionResult.imageData && extractionResult.imageData.length > 0) {
            // Update profile with image data for download phase
            this.profileQueue.updateProfileStatus(
              profile.username, 
              ProfileStatus.DOWNLOADING, 
              { imageData: extractionResult.imageData }
            );
            this.logger.info(`Extraction successful for @${profile.username}: Found ${extractionResult.imageData.length} images`);
          } else {
            // No images found, mark as completed
            this.profileQueue.updateProfileStatus(
              profile.username, 
              ProfileStatus.COMPLETED, 
              { imageData: [] }
            );
            this.logger.warn(`No images found for @${profile.username}`);
          }
        } catch (error) {
          this.logger.error(`Error extracting profile @${profile.username}`, error as Error);
          
          // Mark profile as failed
          this.profileQueue.updateProfileStatus(
            profile.username, 
            ProfileStatus.FAILED, 
            { error: error as Error }
          );
        }
        
        // Add rate limit delay between profiles
        if (this.isRunning) {
          await new Promise(resolve => setTimeout(resolve, this.config.rateLimitDelay));
        }
      }
    } catch (error) {
      this.logger.error('Extraction worker encountered an error', error as Error);
      this.isRunning = false;
    }
  }

  /**
   * Extract images from a Twitter profile
   * @param username Twitter username
   * @returns Extraction result with image data
   */
  private async extractProfile(username: string): Promise<ExtractionResult> {
    try {
      // Navigate to profile media tab
      await this.twitterScraper.navigateToProfileMediaTab(username);
      
      // Check if the account is private or suspended
      if (await this.twitterScraper.isPrivateAccount()) {
        throw new ScraperError(
          `Skipping private account: @${username}`,
          ScraperErrorType.PRIVATE_ACCOUNT_ERROR
        );
      }
      
      if (await this.twitterScraper.isSuspendedAccount()) {
        throw new ScraperError(
          `Skipping suspended account: @${username}`,
          ScraperErrorType.PRIVATE_ACCOUNT_ERROR
        );
      }
      
      // Scroll and load media
      await this.twitterScraper.scrollAndLoadMedia();
      
      // Extract image URLs
      const imageData = await this.twitterScraper.extractImageUrls();
      
      return {
        username,
        success: true,
        imageData
      };
    } catch (error) {
      return {
        username,
        success: false,
        error: error as Error
      };
    }
  }

  /**
   * Stop the worker
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.info(`Extraction worker stopping, current profile: ${this.currentProfile || 'none'}`);
  }
}
