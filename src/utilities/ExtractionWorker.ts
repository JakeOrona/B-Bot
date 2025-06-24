/**
 * ExtractionWorker: Handles the extraction of image URLs from a Twitter profile
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { TwitterScraper } from '../pageObjects/TwitterScraper';
import { ProfileQueue } from './ProfileQueue';
import { ExtractionResult, ExtractionWorkerInterface, ProfileStatus } from '../interfaces/ConcurrentTypes';
import { ScraperConfig, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import { Logger } from './Logger';
import { ProgressLogger } from './ProgressLogger';
import { Semaphore } from './Semaphore';

export class ExtractionWorker implements ExtractionWorkerInterface {
  private page: Page;
  private context: BrowserContext;
  private browser: Browser;
  private config: ScraperConfig;
  private profileQueue: ProfileQueue;
  private isRunning: boolean = false;
  private logger: Logger;
  private progressLogger: ProgressLogger;
  private twitterScraper: TwitterScraper;
  private currentProfile: string | null = null;
  private workerId: number = 0;
  private workerContext: { workerId: number; username?: string } = { workerId: 0 };

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
    profileQueue: ProfileQueue,
    workerId: number = 0
  ) {
    this.page = page;
    this.context = context;
    this.browser = browser;
    this.config = config;
    this.profileQueue = profileQueue;
    this.workerId = workerId;
    this.workerContext = { workerId: this.workerId };
    this.logger = Logger.getInstance();
    this.progressLogger = ProgressLogger.getInstance();
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
        
        // Use a variable accessible to both try blocks
        let profile;
        
        try {
          // Attempt to atomically claim the next profile from queue
          // The profile is already marked as EXTRACTING by getNextWaitingProfile
          profile = this.profileQueue.getNextWaitingProfile();
          
          if (!profile) {
            // No more profiles to process
            await this.progressLogger.info('No waiting profiles available, worker pausing', undefined, undefined, this.workerContext);
            
            // Use shorter wait time to check more frequently
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check if all profiles are done and exit loop if so
            const stats = this.profileQueue.getStats();
            
            // Log status periodically
            if (noProfilesFoundCount % 3 === 0) {
              await this.progressLogger.info(`Worker #${this.workerId} waiting: ${JSON.stringify(stats)} (idle count: ${noProfilesFoundCount})`, undefined, undefined, this.workerContext);
            }
            
            if (stats.waiting === 0 && stats.extracting === 0) {
              noProfilesFoundCount++;
              
              // If we've checked multiple times and found no profiles to process,
              // assume we're done and exit the loop
              if (noProfilesFoundCount >= MAX_EMPTY_ITERATIONS) {
                await this.progressLogger.info(`No profiles to extract after ${MAX_EMPTY_ITERATIONS} checks, worker #${this.workerId} exiting`, undefined, undefined, this.workerContext);
                break;
              }
            } else {
              // Reset counter if there are still profiles being processed
              noProfilesFoundCount = 0;
            }
            continue;
          }
          
          // Successfully claimed a profile - update worker state
          this.currentProfile = profile.username;
          // Update worker context with current username
          this.workerContext = { workerId: this.workerId, username: profile.username };
          
          await this.progressLogger.info(`Worker #${this.workerId} claimed and starting extraction for profile @${profile.username}`, undefined, undefined, this.workerContext);
          
          // No need to update profile status again, as it was already set to EXTRACTING
          // in the atomic getNextWaitingProfile operation
        } catch (profileError) {
          // Error in profile claiming process
          await this.progressLogger.error(`Error claiming next profile for worker #${this.workerId}`, profileError as Error, undefined, this.workerContext);
          
          // Short delay before trying again
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
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
            await this.progressLogger.success(`Extraction successful for @${profile.username}: Found ${extractionResult.imageData.length} images`, undefined, this.workerContext);
          } else {
            // No images found, mark as completed
            this.profileQueue.updateProfileStatus(
              profile.username, 
              ProfileStatus.COMPLETED, 
              { imageData: [] }
            );
            await this.progressLogger.warn(`No images found for @${profile.username}`, this.workerContext);
          }
        } catch (error) {
          await this.progressLogger.error(`Error extracting profile @${profile.username}`, error as Error, undefined, this.workerContext);
          
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
      await this.progressLogger.error('Extraction worker encountered an error', error as Error, undefined, this.workerContext);
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
      
      // Scroll and load media with worker context
      await this.twitterScraper.scrollAndLoadMedia(this.config.maxScrolls, this.workerContext);
      
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
    await this.progressLogger.info(`Extraction worker stopping, current profile: ${this.currentProfile || 'none'}`, undefined, undefined, this.workerContext);
  }
}
