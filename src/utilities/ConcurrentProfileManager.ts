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
    
    // Give extraction workers a head start before starting download processor
    // This ensures they have time to fetch profile pages and start extraction
    this.logger.info('Delaying download processor startup to give extraction workers a head start...');
    await new Promise(resolve => setTimeout(resolve, 4000));
    
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
    // Get the profile item from the queue to verify it has image data
    const profileItem = this.profileQueue.getAllProfiles().find(p => p.username === username);
    
    if (profileItem?.imageData?.length) {
      this.logger.info(`Extraction completed for @${username}, queued for download processing with ${profileItem.imageData.length} images`);
      
      // Additional validation to ensure image data is properly attached
      if (profileItem.imageData.some(img => !img.url)) {
        this.logger.warn(`Warning: Some image data for @${username} may be incomplete. This could cause download issues.`);
      }
      
      // Log the first few image URLs for debugging purposes
      const sampleImageData = profileItem.imageData.slice(0, 2);
      this.logger.info(`Sample image data for @${username}: ${JSON.stringify(sampleImageData)}`);
    } else if (profileItem) {
      this.logger.warn(`Extraction completed for @${username} but no image data found, this may cause download issues`);
    } else {
      this.logger.error(`Extraction completed event received for @${username} but profile not found in queue`);
    }
  }

  /**
   * Process profiles pending download
   */
  private async processPendingDownloads(): Promise<void> {
    try {
      let idleCount = 0;
      const MAX_IDLE_ITERATIONS = 20; // Increased significantly to prevent premature exit
      const PROCESS_TIMEOUT_MS = this.concurrentConfig.extractionTimeoutMs * 2; // Double the extraction timeout
      const startTime = Date.now();
      let lastProfileCount = 0;
      let waitingForExtraction = true; // Flag to indicate we're expecting extraction workers to complete
      let initialExtractionPhase = true; // Flag to indicate initial extraction phase
      
      this.logger.info(`Download processor started - will process images as they become available`);
      
      // Add status check interval to force periodic status checks
      const statusCheckInterval = setInterval(() => {
        const stats = this.profileQueue.getStats();
        this.logger.info(`Download processor status check: ${JSON.stringify(stats)}`);
        
        // Debug info about profiles in downloading status
        if (stats.downloading > 0) {
          const downloadingProfiles = this.profileQueue.getAllProfiles().filter(p => p.status === ProfileStatus.DOWNLOADING);
          for (const profile of downloadingProfiles) {
            this.logger.info(`Download pending for @${profile.username} with ${profile.imageData?.length || 0} images`);
          }
        }
        
        // Exit condition: If the number of profiles in process hasn't changed for a while
        if (stats.extracting === 0 && stats.downloading === lastProfileCount && 
            lastProfileCount > 0 && idleCount > MAX_IDLE_ITERATIONS / 2) {
          this.logger.warn(`Profile count unchanged for ${idleCount} iterations, possible stall detected`);
        }
        
        // If there are still extraction workers running, we should wait
        if (stats.extracting > 0) {
          this.logger.info(`Download processor waiting for ${stats.extracting} extraction worker(s) to complete`);
          waitingForExtraction = true;
        } else if (waitingForExtraction) {
          // If extraction was happening but now done, reset idle counter to give time for transitions
          if (stats.downloading > 0) {
            this.logger.info(`Extraction phase complete. Starting download phase for ${stats.downloading} profile(s)`);
            idleCount = 0;
            waitingForExtraction = false;
          }
        }
        
        lastProfileCount = stats.downloading;
      }, 5000); // Check every 5 seconds
      
      try {
        // Wait for a short time to allow extraction workers to start
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        while ((this.isRunning || !this.profileQueue.isAllDone()) && 
               (Date.now() - startTime < PROCESS_TIMEOUT_MS)) {
          
          const queueStats = this.profileQueue.getStats();

          // Debug log showing queue status at each iteration
          if (idleCount % 3 === 0 || idleCount === 0) {
            this.logger.info(`Download processor iteration - Queue status: ${JSON.stringify(queueStats)}, Idle count: ${idleCount}`);
          }
          
          // Get all profiles that need downloading
          const allProfiles = this.profileQueue.getAllProfiles();
          const downloadingProfiles = allProfiles.filter(p => p.status === ProfileStatus.DOWNLOADING);
          
          // If we're in the initial phase and no profiles are in downloading status yet
          if (initialExtractionPhase && queueStats.downloading === 0 && queueStats.extracting > 0) {
            this.logger.info(`Initial extraction phase in progress. Waiting for profiles to complete extraction.`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          
          // If all profiles have been processed and no downloads are occurring, we can exit
          if (queueStats.total > 0 && 
              queueStats.total === (queueStats.completed + queueStats.failed) &&
              queueStats.waiting === 0 && queueStats.extracting === 0 && queueStats.downloading === 0) {
            this.logger.info(`All profiles have completed processing, download processor exiting`);
            break;
          }
          
          // If there are still extractions in progress, wait with patience
          if (queueStats.extracting > 0) {
            waitingForExtraction = true;
            this.logger.info(`Download processor waiting for ${queueStats.extracting} extraction(s) to complete`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          } else if (waitingForExtraction && queueStats.downloading > 0) {
            // Just finished extraction and we have downloads waiting - reset idle counter and exit initial phase
            this.logger.info(`All extractions complete. Found ${queueStats.downloading} profiles waiting for download`);
            idleCount = 0;
            waitingForExtraction = false;
            initialExtractionPhase = false;
          }
          
          // Process one profile at a time for downloads to avoid memory issues
          if (downloadingProfiles.length > 0) {
            // Reset idle counter when work is found
            idleCount = 0;
            initialExtractionPhase = false; // We're now in download phase
            
            const profile = downloadingProfiles[0];
            
            try {
              // Verify the profile has image data
              if (!profile.imageData || profile.imageData.length === 0) {
                this.logger.warn(`Profile @${profile.username} has no image data attached. Queue may be corrupted.`);
                
                // Re-check directly from queue to be sure
                const freshProfile = this.profileQueue.getAllProfiles().find(p => p.username === profile.username);
                if (freshProfile?.imageData?.length) {
                  this.logger.info(`Re-checked profile @${profile.username} and found ${freshProfile.imageData.length} images`);
                  profile.imageData = freshProfile.imageData;
                }
              }
              
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
              this.logger.info(`No profiles ready for download, waiting... (idle count: ${idleCount}/${MAX_IDLE_ITERATIONS})`);
              
              // Detailed debug to help understand if there are stuck profiles
              const profilesWithStatus = this.profileQueue.getAllProfiles().map(p => {
                return {
                  username: p.username,
                  status: p.status,
                  imageCount: p.imageData?.length || 0
                };
              });
              
              this.logger.info(`Current profiles status: ${JSON.stringify(profilesWithStatus)}`);
            }
            
            // If we've been idle for too long with no new downloads, but still have extractions running, be patient
            if (queueStats.extracting > 0) {
              this.logger.info(`Waiting for ${queueStats.extracting} extraction(s) to complete`);
              idleCount = Math.min(idleCount, MAX_IDLE_ITERATIONS / 2); // Keep idle count below threshold
            }
            // If we've been idle for too long with no extractions running, exit
            else if (idleCount >= MAX_IDLE_ITERATIONS && queueStats.extracting === 0) {
              this.logger.info(`No profiles to download after ${MAX_IDLE_ITERATIONS} checks with no extractions running, download processor exiting`);
              break;
            }
            
            // Shorter wait time to check more frequently
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          // Check if all processing is complete - this is a crucial exit condition
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
              idleCount >= MAX_IDLE_ITERATIONS * 0.75 && queueStats.downloading > 0) {
            this.logger.warn(`Potential stall detected with ${queueStats.downloading} downloads pending but no progress after ${idleCount} checks`);
            
            // Show more detailed info about these profiles
            const stuckProfiles = allProfiles.filter(p => p.status === ProfileStatus.DOWNLOADING);
            for (const profile of stuckProfiles) {
              this.logger.warn(`Possibly stuck profile: @${profile.username} with ${profile.imageData?.length || 0} images`);
            }
            
            // If we've had multiple warnings about stalled downloads, mark them as failed and exit
            if (idleCount >= MAX_IDLE_ITERATIONS) {
              this.logger.warn(`Forcing completion of ${queueStats.downloading} stalled download(s)`);
              
              // Mark any stuck downloads as failed
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
    const allProfiles = this.profileQueue.getAllProfiles();
    
    // Calculate total images extracted across all profiles
    const totalImagesExtracted = allProfiles
      .filter(p => p.imageData)
      .reduce((sum, p) => sum + (p.imageData?.length || 0), 0);
    
    // Calculate profiles with successful image extraction
    const profilesWithImages = allProfiles.filter(p => p.imageData && p.imageData.length > 0).length;
    
    // Get detailed download stats 
    const stats = {
      totalProfiles: queueStats.total,
      completedProfiles: queueStats.completed,
      failedProfiles: queueStats.failed,
      profilesWithImages: profilesWithImages,
      totalImagesExtracted: totalImagesExtracted,
      totalImagesDownloaded: this.downloadStats.successful,
      totalImages: this.downloadStats.total
    };
    
    // Debug log the individual profiles
    this.logger.info(`Final statistics: ${JSON.stringify(stats)}`);
    this.logger.info(`Download statistics: ${JSON.stringify(this.downloadStats)}`);
    
    // Log details for each profile for debugging
    this.logger.info(`=== DETAILED PROFILE REPORT ===`);
    for (const profile of allProfiles) {
      // Calculate completion time in seconds if available
      let processingTimeSeconds = 'n/a';
      if (profile.startTime && profile.completionTime) {
        processingTimeSeconds = ((profile.completionTime - profile.startTime) / 1000).toFixed(1) + 's';
      }
      
      this.logger.info(
        `Profile @${profile.username}: ` +
        `status=${profile.status}, ` + 
        `images extracted=${profile.imageData?.length || 0}, ` +
        `processing time=${processingTimeSeconds}`
      );
      
      // For completed profiles, add status info
      if (profile.status === ProfileStatus.COMPLETED) {
        // We don't have direct image download counts per profile in the current system
        // A future improvement could track downloads per profile
        this.logger.info(`  - Download completed successfully for @${profile.username}`);
      } else if (profile.status === ProfileStatus.FAILED) {
        this.logger.error(`  - Processing failed for @${profile.username}: ${profile.error?.message || 'Unknown error'}`);
      }
    }
    this.logger.info(`===========================`);
    
    return stats;
  }
}
