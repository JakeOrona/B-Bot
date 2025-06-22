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
      // Add maximum loop counter for safety
      let noProfilesFoundCount = 0;
      let totalIterationCount = 0;
      const MAX_EMPTY_ITERATIONS = 5; // Reduced from 10 to exit faster
      const MAX_TOTAL_ITERATIONS = 1000; // Absolute maximum to prevent infinite loops
      const startTime = Date.now();
      const MAX_RUNTIME_MS = 15 * 60 * 1000; // 15 minutes maximum runtime
      
      while (this.isRunning && 
             totalIterationCount < MAX_TOTAL_ITERATIONS &&
             (Date.now() - startTime) < MAX_RUNTIME_MS) {
        
        totalIterationCount++;
        
        // Get next profile from queue
        const profile = this.profileQueue.getNextWaitingProfile();
        
        if (!profile) {
          // No more profiles to process
          this.logger.info('No more profiles to extract, worker pausing');
          
          // Use shorter wait time to check more frequently
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Check if all profiles are done and exit loop if so
          const stats = this.profileQueue.getStats();
          
          // Log status periodically
          if (noProfilesFoundCount % 3 === 0) {
            this.logger.info(`Worker waiting: ${JSON.stringify(stats)} (idle count: ${noProfilesFoundCount})`);
          }
          
          if (stats.waiting === 0 && stats.extracting === 0) {
            noProfilesFoundCount++;
            
            // If we've checked multiple times and found no profiles to process,
            // assume we're done and exit the loop
            if (noProfilesFoundCount >= MAX_EMPTY_ITERATIONS) {
              this.logger.info(`No profiles to extract after ${MAX_EMPTY_ITERATIONS} checks, worker exiting`);
              break;
            }
          } else {
            // Reset counter if there are still profiles being processed
            noProfilesFoundCount = 0;
          }
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
