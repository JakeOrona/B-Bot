/**
 * ConcurrentProfileManager: Manages concurrent processing of Twitter profiles
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { ProfileQueue } from './ProfileQueue';
import { ExtractionWorker } from './ExtractionWorker';
import { EventEmitter } from 'events';
import { ConcurrentProcessingConfig, ConcurrentProcessingStats, ConcurrentProfileEvent, ProfileStatus } from '../interfaces/ConcurrentTypes';
import { DownloadStats, ImageData, ScraperConfig, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import { Logger } from './Logger';
import { TwitterScraper } from '../pageObjects/TwitterScraper';
import { ProgressLogger } from './ProgressLogger';

export class ConcurrentProfileManager extends EventEmitter {
  private profileQueue: ProfileQueue;
  private workers: ExtractionWorker[] = [];
  private config: ScraperConfig;
  private concurrentConfig: ConcurrentProcessingConfig;
  private logger: Logger;
  private progressLogger: ProgressLogger;
  private downloadStats: DownloadStats = { total: 0, successful: 0, failed: 0, skipped: 0 };
  private isRunning: boolean = false;
  private browser: Browser;
  private context: BrowserContext;
  private mainPage: Page;
  private downloadWorkerTwitterScraper: TwitterScraper | null = null;

  /**
   * Constructor
   * @param browser Playwright Browser instance
   * @param context Playwright BrowserContext instance
   * @param page Main Playwright Page instance
   * @param config Scraper configuration
   * @param concurrentConfig Concurrent processing configuration
   */
  constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    config: ScraperConfig,
    concurrentConfig: ConcurrentProcessingConfig
  ) {
    super();
    this.browser = browser;
    this.context = context;
    this.mainPage = page;
    this.config = config;
    this.concurrentConfig = concurrentConfig;
    this.logger = Logger.getInstance();
    this.progressLogger = ProgressLogger.getInstance();
    this.profileQueue = new ProfileQueue(concurrentConfig.queueMaxSize);
    
    // Set up event listeners for the profile queue
    this.setupQueueEventListeners();
  }

  /**
   * Set up event listeners for the profile queue
   */
  private setupQueueEventListeners(): void {
    this.profileQueue.on(ConcurrentProfileEvent.EXTRACTION_COMPLETE, (profileItem) => {
      this.handleExtractionComplete(profileItem.username);
    });
    
    this.profileQueue.on(ConcurrentProfileEvent.PROFILE_COMPLETE, (profileItem) => {
      this.logger.info(`Profile @${profileItem.username} processing completed`);
    });
    
    this.profileQueue.on(ConcurrentProfileEvent.PROFILE_FAILED, (profileItem) => {
      this.logger.error(`Profile @${profileItem.username} processing failed`, profileItem.error);
    });
  }

  /**
   * Start processing profiles
   * @param usernames Array of Twitter usernames to process
   */
  public async startProcessing(usernames: string[]): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Profile processing is already running');
      return;
    }
    
    this.isRunning = true;
    this.logger.info(`Starting concurrent processing for ${usernames.length} profiles with max concurrency of ${this.concurrentConfig.maxConcurrentProfiles}`);
    
    // Add profiles to the queue
    this.profileQueue.addProfiles(usernames);
    
    // Initialize workers
    await this.initializeWorkers();
    
    // Initialize download worker
    await this.initializeDownloadWorker();
    
    // Start workers
    const workerPromises = this.workers.map(worker => worker.start());
    
    // Start download processor
    const downloadProcessorPromise = this.processPendingDownloads();
    
    // Wait for all processing to complete
    try {
      await Promise.all([...workerPromises, downloadProcessorPromise]);
      this.logger.info('All profile processing completed');
      this.emit(ConcurrentProfileEvent.ALL_COMPLETE, this.getProcessingStats());
    } catch (error) {
      this.logger.error('Error during concurrent profile processing', error as Error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Initialize extraction workers
   */
  private async initializeWorkers(): Promise<void> {
    try {
      // Create workers up to max concurrent profiles
      for (let i = 0; i < this.concurrentConfig.maxConcurrentProfiles; i++) {
        // Create new page for this worker
        const page = await this.context.newPage();
        
        // Create extraction worker
        const worker = new ExtractionWorker(
          page,
          this.context,
          this.browser,
          this.config,
          this.profileQueue
        );
        
        this.workers.push(worker);
        this.logger.info(`Initialized extraction worker #${i + 1}`);
      }
    } catch (error) {
      this.logger.error('Error initializing extraction workers', error as Error);
      throw error;
    }
  }

  /**
   * Initialize download worker
   */
  private async initializeDownloadWorker(): Promise<void> {
    try {
      // We'll use the main page for downloads to avoid creating too many contexts
      this.downloadWorkerTwitterScraper = new TwitterScraper(
        this.mainPage,
        this.context,
        this.browser,
        this.config
      );
      
      this.logger.info('Download worker initialized');
    } catch (error) {
      this.logger.error('Error initializing download worker', error as Error);
      throw error;
    }
  }

  /**
   * Handle extraction completion event
   */
  private async handleExtractionComplete(username: string): Promise<void> {
    this.logger.info(`Extraction completed for @${username}, queued for download processing`);
  }

  /**
   * Process profiles pending download
   */
  private async processPendingDownloads(): Promise<void> {
    try {
      while (this.isRunning || !this.profileQueue.isAllDone()) {
        // Get all profiles that need downloading
        const allProfiles = this.profileQueue.getAllProfiles();
        const downloadingProfiles = allProfiles.filter(p => p.status === ProfileStatus.DOWNLOADING);
        
        // Process one profile at a time for downloads to avoid memory issues
        if (downloadingProfiles.length > 0) {
          const profile = downloadingProfiles[0];
          
          try {
            this.logger.info(`Starting download process for @${profile.username} with ${profile.imageData?.length || 0} images`);
            
            if (profile.imageData && profile.imageData.length > 0 && this.downloadWorkerTwitterScraper) {
              // Process downloads
              const downloadResult = await this.downloadWorkerTwitterScraper.downloadImages(profile.imageData);
              
              // Update statistics
              this.downloadStats.total += downloadResult.stats.total;
              this.downloadStats.successful += downloadResult.stats.successful;
              this.downloadStats.failed += downloadResult.stats.failed;
              this.downloadStats.skipped += downloadResult.stats.skipped;
              
              // Mark as completed
              this.profileQueue.updateProfileStatus(
                profile.username, 
                ProfileStatus.COMPLETED
              );
              
              this.logger.info(
                `Download completed for @${profile.username}: ` +
                `${downloadResult.stats.successful}/${downloadResult.stats.total} successful, ` +
                `${downloadResult.stats.failed} failed, ${downloadResult.stats.skipped} skipped`
              );
            } else {
              // No images to download
              this.profileQueue.updateProfileStatus(
                profile.username, 
                ProfileStatus.COMPLETED
              );
              
              this.logger.warn(`No images to download for @${profile.username}`);
            }
          } catch (error) {
            this.logger.error(`Error downloading images for @${profile.username}`, error as Error);
            
            // Mark as failed
            this.profileQueue.updateProfileStatus(
              profile.username, 
              ProfileStatus.FAILED, 
              { error: error as Error }
            );
          }
        } else {
          // No profiles ready for downloading, wait a bit
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Check if all processing is complete
        const queueStats = this.profileQueue.getStats();
        if (queueStats.extracting === 0 && queueStats.downloading === 0 && queueStats.waiting === 0) {
          if (!this.profileQueue.isAllDone()) {
            // Sanity check - this shouldn't happen
            this.logger.warn('No more profiles to process but queue is not marked as done');
          }
          break;
        }
      }
    } catch (error) {
      this.logger.error('Error in download processor', error as Error);
      throw error;
    }
  }

  /**
   * Stop all processing
   */
  public async stopProcessing(): Promise<void> {
    this.isRunning = false;
    
    // Stop all workers
    for (const worker of this.workers) {
      await worker.stop();
    }
    
    this.logger.info('Concurrent profile processing stopped');
  }

  /**
   * Get download statistics
   */
  public getDownloadStats(): DownloadStats {
    return { ...this.downloadStats };
  }

  /**
   * Get processing statistics
   */
  public getProcessingStats(): ConcurrentProcessingStats {
    const queueStats = this.profileQueue.getStats();
    
    return {
      totalProfiles: queueStats.total,
      completedProfiles: queueStats.completed,
      failedProfiles: queueStats.failed,
      totalImagesExtracted: this.profileQueue.getAllProfiles()
        .filter(p => p.imageData)
        .reduce((sum, p) => sum + (p.imageData?.length || 0), 0),
      totalImagesDownloaded: this.downloadStats.successful,
      totalImages: this.downloadStats.total
    };
  }
}
