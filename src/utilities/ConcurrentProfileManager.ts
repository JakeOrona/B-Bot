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
    
    // Add aggressive overall processing timeout - if this triggers, everything gets aborted
    const HARD_TIMEOUT_MS = this.concurrentConfig.extractionTimeoutMs * 3; 
    const overallTimeout = setTimeout(() => {
      this.logger.error(`HARD TIMEOUT reached after ${HARD_TIMEOUT_MS}ms, forcing shutdown`);
      this.isRunning = false; // Set running to false to signal all loops to exit
      this.stopProcessing();
      
      // Force process to exit after additional grace period if things are truly stuck
      const GRACE_PERIOD_MS = 30000; // 30 seconds grace period
      setTimeout(() => {
        this.logger.error(`Process appears to be stuck after grace period, forcing process exit`);
        process.exit(1); // Force exit with error code if we're truly stuck
      }, GRACE_PERIOD_MS);
      
    }, HARD_TIMEOUT_MS);
    
    // Add status tracking to detect stuck processing
    let lastQueueStats = this.profileQueue.getStats();
    let unchangedStatsCount = 0;
    const MAX_UNCHANGED_STATS = 5;
    
    const statusCheckInterval = setInterval(() => {
      const currentStats = this.profileQueue.getStats();
      this.logger.info(`Processing status: ${JSON.stringify(currentStats)}`);
      
      // Check if stats are unchanged (possible deadlock)
      if (JSON.stringify(currentStats) === JSON.stringify(lastQueueStats)) {
        unchangedStatsCount++;
        if (unchangedStatsCount >= MAX_UNCHANGED_STATS) {
          this.logger.warn(`Queue stats unchanged for ${MAX_UNCHANGED_STATS} checks, possible deadlock`);
        }
      } else {
        unchangedStatsCount = 0;
        lastQueueStats = currentStats;
      }
      
      // If everything is completed or failed, we can stop early
      if (currentStats.total > 0 && 
          currentStats.total === (currentStats.completed + currentStats.failed) &&
          currentStats.waiting === 0 && currentStats.extracting === 0 && currentStats.downloading === 0) {
        this.logger.info(`All profiles processed (${currentStats.completed} completed, ${currentStats.failed} failed), stopping workers`);
        this.stopProcessing();
        clearInterval(statusCheckInterval);
      }
    }, 10000); // Check every 10 seconds
    
    // Start workers with a Promise.race to handle the case where some workers
    // complete but others are stuck
    const workerPromises = this.workers.map((worker, index) => {
      // Add individual timeout for each worker
      const workerTimeoutMs = this.concurrentConfig.extractionTimeoutMs;
      
      return Promise.race([
        worker.start().then(() => {
          this.logger.info(`Worker #${index + 1} completed normally`);
        }),
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            this.logger.warn(`Worker #${index + 1} timeout reached after ${workerTimeoutMs}ms`);
            reject(new Error(`Worker #${index + 1} timeout reached after ${workerTimeoutMs}ms`));
          }, workerTimeoutMs);
        })
      ]);
    });
    
    // Start download processor with timeout
    const downloadTimeoutMs = this.concurrentConfig.extractionTimeoutMs * 2;
    const downloadProcessorPromise = Promise.race([
      this.processPendingDownloads().then(() => {
        this.logger.info('Download processor completed normally');
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          this.logger.warn(`Download processor timeout reached after ${downloadTimeoutMs}ms`);
          reject(new Error(`Download processor timeout reached after ${downloadTimeoutMs}ms`));
        }, downloadTimeoutMs);
      })
    ]);
    
    // Wait for all processing to complete
    try {
      // Use Promise.allSettled instead of Promise.all to handle partial failures
      const results = await Promise.allSettled([...workerPromises, downloadProcessorPromise]);
      
      // Check for any failures
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        this.logger.warn(`${failures.length} worker(s) failed to complete normally`);
        for (let i = 0; i < failures.length; i++) {
          const failure = failures[i] as PromiseRejectedResult;
          this.logger.error(`Worker failure ${i + 1}: ${failure.reason}`);
        }
      }
      
      this.logger.info('All profile processing completed');
      this.emit(ConcurrentProfileEvent.ALL_COMPLETE, this.getProcessingStats());
    } catch (error) {
      this.logger.error('Error during concurrent profile processing', error as Error);
    } finally {
      // Clean up timeouts
      clearTimeout(overallTimeout);
      clearInterval(statusCheckInterval);
      
      // Stop all workers and clean up
      await this.stopProcessing();
      
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
      let idleCount = 0;
      const MAX_IDLE_ITERATIONS = 5; // Reduced from 10 to exit faster
      const PROCESS_TIMEOUT_MS = this.concurrentConfig.extractionTimeoutMs * 2; // Double the extraction timeout
      const startTime = Date.now();
      let lastProfileCount = 0;
      
      // Add status check interval to force periodic status checks
      const statusCheckInterval = setInterval(() => {
        const stats = this.profileQueue.getStats();
        this.logger.info(`Download processor status check: ${JSON.stringify(stats)}`);
        
        // Exit condition: If the number of profiles in process hasn't changed for a while
        if (stats.extracting === 0 && stats.downloading === lastProfileCount && 
            lastProfileCount > 0 && idleCount > MAX_IDLE_ITERATIONS / 2) {
          this.logger.warn(`Profile count unchanged for ${idleCount} iterations, possible stall detected`);
        }
        
        lastProfileCount = stats.downloading;
      }, 10000); // Check every 10 seconds
      
      try {
        while ((this.isRunning || !this.profileQueue.isAllDone()) && 
               (Date.now() - startTime < PROCESS_TIMEOUT_MS)) {
          
          // Get all profiles that need downloading
          const allProfiles = this.profileQueue.getAllProfiles();
          const downloadingProfiles = allProfiles.filter(p => p.status === ProfileStatus.DOWNLOADING);
          
          // Process one profile at a time for downloads to avoid memory issues
          if (downloadingProfiles.length > 0) {
            // Reset idle counter when work is found
            idleCount = 0;
            
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
            // No profiles ready for downloading, increment idle counter
            idleCount++;
            
            // Log only occasionally to reduce noise
            if (idleCount % 3 === 0) {
              this.logger.info(`No profiles ready for download, waiting... (idle count: ${idleCount})`);
            }
            
            // If we've been idle for too long with no new downloads, exit
            if (idleCount >= MAX_IDLE_ITERATIONS) {
              this.logger.info(`No profiles to download after ${MAX_IDLE_ITERATIONS} checks, download processor exiting`);
              break;
            }
            
            // Shorter wait time to check more frequently
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          // Check if all processing is complete - this is a crucial exit condition
          const queueStats = this.profileQueue.getStats();
          if (queueStats.extracting === 0 && queueStats.downloading === 0 && queueStats.waiting === 0) {
            if (!this.profileQueue.isAllDone()) {
              // Sanity check - this shouldn't happen
              this.logger.warn('No more profiles to process but queue is not marked as done');
            }
            this.logger.info('All profiles processed, download processor exiting');
            break;
          }
          
          // Aggressive exit strategy: If everything is done except a few stuck downloads
          if (queueStats.extracting === 0 && queueStats.waiting === 0 && 
              idleCount >= MAX_IDLE_ITERATIONS / 2 && queueStats.downloading > 0) {
            this.logger.warn(`Potential stall detected with ${queueStats.downloading} downloads pending but no progress after ${idleCount} checks`);
            
            // If we've had multiple warnings about stalled downloads, mark them as failed and exit
            if (idleCount >= MAX_IDLE_ITERATIONS) {
              this.logger.warn(`Forcing completion of ${queueStats.downloading} stalled download(s)`);
              
              // Mark any stuck downloads as failed
              const stuckProfiles = allProfiles.filter(p => p.status === ProfileStatus.DOWNLOADING);
              for (const profile of stuckProfiles) {
                this.profileQueue.updateProfileStatus(
                  profile.username,
                  ProfileStatus.FAILED,
                  { error: new Error('Download stalled') }
                );
              }
              
              break;
            }
          }
        }
      } finally {
        // Always clear the interval to prevent memory leaks
        clearInterval(statusCheckInterval);
      }
      
      // Check if we timed out
      if (Date.now() - startTime >= PROCESS_TIMEOUT_MS) {
        this.logger.warn(`Download processor timed out after ${PROCESS_TIMEOUT_MS}ms, forcing exit`);
        
        // Mark any remaining profiles as failed
        const remainingProfiles = this.profileQueue.getAllProfiles()
          .filter(p => p.status !== ProfileStatus.COMPLETED && p.status !== ProfileStatus.FAILED);
          
        for (const profile of remainingProfiles) {
          this.profileQueue.updateProfileStatus(
            profile.username,
            ProfileStatus.FAILED,
            { error: new Error('Processing timed out') }
          );
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
