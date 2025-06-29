/**
 * Main entry point for the Twitter/X Image Scraper
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { TwitterAuth } from './pageObjects/TwitterAuth';
import { TwitterScraper } from './pageObjects/TwitterScraper';
import { ConfigManager } from './utilities/ConfigManager';
import { Logger } from './utilities/Logger';
import { GoogleDriveUploader } from './utilities/GoogleDriveUploader';
import { FileCleanup } from './utilities/FileCleanup';
import { ScraperError, ScraperErrorType } from './interfaces/ScraperTypes';
import { WorkerPool, WorkerResult, ProcessingMode } from './utilities/ArtistWorker';
import path from 'path';
import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Main class for the scraper application
 */
class TwitterImageScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private configManager: ConfigManager;
  private logger: Logger;
  private googleDriveUploader: GoogleDriveUploader | null = null;
  
  /**
   * Constructor
   */
  constructor() {
    this.configManager = ConfigManager.getInstance();
    this.logger = Logger.getInstance();
  }
  
  /**
   * Initialize the scraper
   */
  public async initialize(): Promise<void> {
    try {
      // Create default config files if they don't exist
      this.configManager.createDefaultConfigFiles();
      
      // Get scraper configuration
      const config = this.configManager.getScraperConfig();
      
      // Add Google Drive configuration if enabled
      const googleDriveConfig = this.configManager.getGoogleDriveConfig();
      if (googleDriveConfig.enableUpload) {
        config.googleDrive = googleDriveConfig;
        this.logger.info('Google Drive integration enabled');
      }
      
      this.logger.info('Starting Twitter/X Image Scraper');
      this.logger.info(`Headless mode: ${config.headless ? 'enabled' : 'disabled'}`);
      
      // Launch browser
      this.browser = await chromium.launch({
        headless: config.headless
      });
      
      // Create browser context with specific options
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        timezoneId: 'America/New_York',
      });
      
      // Create new page
      this.page = await this.context.newPage();
      
      // Initialize Google Drive uploader if enabled
      if (googleDriveConfig.enableUpload && googleDriveConfig.rootFolderId) {
        try {
          this.googleDriveUploader = new GoogleDriveUploader(
            googleDriveConfig.credentialsPath,
            googleDriveConfig.rootFolderId
          );
          this.logger.info('Google Drive uploader initialized');
        } catch (error) {
          this.logger.error('Failed to initialize Google Drive uploader', error as Error);
          // Continue without Google Drive upload capability
        }
      }
      
      this.logger.info('Browser initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize scraper', error as Error);
      throw error;
    }
  }
  
  /**
   * Run the full scraper process using worker pool (scrape + upload)
   */
  public async run(processingMode: ProcessingMode = ProcessingMode.DISTRIBUTED): Promise<void> {
      if (!this.browser) {
          throw new Error('Scraper not initialized. Call initialize() first.');
      }

      try {
          const authCredentials = this.configManager.getAuthCredentials();
          const scraperConfig = this.configManager.getScraperConfig();
          
          // Get list of artists to scrape
          const artists = this.configManager.loadArtists();
          this.logger.info(`Found ${artists.length} artists to scrape using worker pool in ${processingMode.toUpperCase()} mode`);
          
          // Check Google Drive configuration and create uploader if enabled
          const googleDriveConfig = this.configManager.getGoogleDriveConfig();
          let googleDriveUploader = null;
          
          if (googleDriveConfig.enableUpload && googleDriveConfig.rootFolderId) {
              try {
                  googleDriveUploader = new GoogleDriveUploader(
                      googleDriveConfig.credentialsPath,
                      googleDriveConfig.rootFolderId
                  );
                  this.logger.info('Google Drive uploader initialized for worker pool');
              } catch (error) {
                  this.logger.error('Failed to initialize Google Drive uploader for worker pool', error as Error);
                  // Continue without Google Drive upload capability
              }
          } else {
              this.logger.info('Google Drive upload disabled or not configured');
          }
          
          // Initialize worker pool with Google Drive uploader
          const workerPool = new WorkerPool(
              this.browser,
              authCredentials,
              scraperConfig,
              googleDriveUploader, // Pass the uploader to workers
              3 // 3 workers as requested
          );
          
          await workerPool.initialize();
          
          try {
              // Process all artists using specified processing mode
              this.logger.info(`Starting ${processingMode} processing with worker pool...`);
              const startTime = Date.now();
              
              // Use the specified processing mode
              const results = await workerPool.processArtistsWithMode(artists, processingMode);
              
              const endTime = Date.now();
              const totalTime = Math.round((endTime - startTime) / 1000);
              
              // Log detailed results
              this.logWorkerResults(results);
              
              // Get aggregated statistics
              const aggregatedStats = WorkerPool.getAggregatedStats(results);
              
              this.logger.success(
                  `${processingMode.toUpperCase()} worker pool processing completed in ${totalTime} seconds:\n` +
                  `  Artists: ${aggregatedStats.successfulArtists}/${aggregatedStats.totalArtists} successful, ` +
                  `${aggregatedStats.skippedArtists} skipped, ${aggregatedStats.failedArtists} failed\n` +
                  `  Downloads: ${aggregatedStats.downloadStats.successful}/${aggregatedStats.downloadStats.total} successful` +
                  (aggregatedStats.uploadStats ? 
                      `\n  Uploads: ${aggregatedStats.uploadStats.successful}/${aggregatedStats.uploadStats.total} successful` : 
                      `\n  Uploads: Not enabled or configured`)
              );
              
          } finally {
              // Always clean up worker pool
              await workerPool.cleanup();
          }
          
          // Clean up old files based on retention policy
          try {
              this.logger.info('Starting cleanup of files older than 3 days...');
              await FileCleanup.cleanupOldFiles(scraperConfig.downloadPath, 3);
              this.logger.info('File cleanup completed');
          } catch (error) {
              this.logger.error('File cleanup failed', error as Error);
          }
          
      } catch (error) {
          this.logger.error(`${processingMode} worker pool execution failed`, error as Error);
          throw error;
      } finally {
          await this.cleanup();
      }
  }
  
  /**
   * Run scrape-only mode using worker pool (without uploading to Google Drive)
   */
  public async runScrapeOnly(processingMode: ProcessingMode = ProcessingMode.DISTRIBUTED): Promise<void> {
      if (!this.browser) {
          throw new Error('Scraper not initialized. Call initialize() first.');
      }

      try {
          const authCredentials = this.configManager.getAuthCredentials();
          const scraperConfig = this.configManager.getScraperConfig();
          
          // Get list of artists to scrape
          const artists = this.configManager.loadArtists();
          this.logger.info(`Found ${artists.length} artists to scrape in scrape-only mode using ${processingMode.toUpperCase()} worker pool`);
          
          // Initialize worker pool without Google Drive uploader
          const workerPool = new WorkerPool(
              this.browser,
              authCredentials,
              scraperConfig,
              null, // No Google Drive uploader for scrape-only
              3 // 3 workers as requested
          );
          
          await workerPool.initialize();
          
          try {
              // Process all artists using specified processing mode
              this.logger.info(`Starting ${processingMode} scrape-only processing with worker pool...`);
              const startTime = Date.now();
              
              // Use the specified processing mode
              const results = await workerPool.processArtistsWithMode(artists, processingMode);
              
              const endTime = Date.now();
              const totalTime = Math.round((endTime - startTime) / 1000);
              
              // Log detailed results
              this.logWorkerResults(results);
              
              // Get aggregated statistics
              const aggregatedStats = WorkerPool.getAggregatedStats(results);
              
              this.logger.success(
                  `${processingMode.toUpperCase()} worker pool scrape-only completed in ${totalTime} seconds:\n` +
                  `  Artists: ${aggregatedStats.successfulArtists}/${aggregatedStats.totalArtists} successful, ` +
                  `${aggregatedStats.skippedArtists} skipped, ${aggregatedStats.failedArtists} failed\n` +
                  `  Downloads: ${aggregatedStats.downloadStats.successful}/${aggregatedStats.downloadStats.total} successful`
              );
              
          } finally {
              // Always clean up worker pool
              await workerPool.cleanup();
          }
          
      } catch (error) {
          this.logger.error(`${processingMode} scrape-only worker pool execution failed`, error as Error);
          throw error;
      } finally {
          await this.cleanup();
      }
  }
  
  /**
   * Run upload-only mode with concurrent processing (upload existing images without scraping)
   */
  public async runUploadOnly(processingMode: ProcessingMode = ProcessingMode.DISTRIBUTED): Promise<void> {
      try {
          const scraperConfig = this.configManager.getScraperConfig();
          
          // Ensure Google Drive uploader is initialized
          const googleDriveConfig = this.configManager.getGoogleDriveConfig();
          if (!googleDriveConfig.enableUpload) {
              throw new Error('Google Drive upload is not enabled in configuration');
          }
          
          let googleDriveUploader: GoogleDriveUploader;
          try {
              googleDriveUploader = new GoogleDriveUploader(
                  googleDriveConfig.credentialsPath,
                  googleDriveConfig.rootFolderId
              );
              this.logger.info('Google Drive uploader initialized for upload-only mode');
          } catch (error) {
              throw new Error(`Failed to initialize Google Drive uploader: ${(error as Error).message}`);
          }
          
          this.logger.info(`Starting upload-only mode with ${processingMode.toUpperCase()} processing`);
          
          // Scan existing images in the download directory
          const existingImages = await this.scanExistingImages(scraperConfig.downloadPath);
          
          if (Object.keys(existingImages).length === 0) {
              this.logger.info('No images found in the download directory to upload.');
              return;
          }
          
          this.logger.info(`Found ${Object.keys(existingImages).length} artists with images to upload using concurrent processing`);
          
          // Create upload tasks for concurrent processing
          const uploadTasks: { artist: string; imagePaths: string[] }[] = [];
          for (const artist of Object.keys(existingImages)) {
              const imagePaths = existingImages[artist];
              if (imagePaths.length > 0) {
                  uploadTasks.push({ artist, imagePaths });
              }
          }
          
          this.logger.info(`Processing ${uploadTasks.length} upload tasks with ${processingMode} mode`);
          
          // Process upload tasks concurrently based on the selected mode
          const startTime = Date.now();
          let results: any[] = [];
          
          if (processingMode === ProcessingMode.DISTRIBUTED) {
              results = await this.processUploadTasksDistributed(uploadTasks, googleDriveUploader);
          } else if (processingMode === ProcessingMode.MAX_CONCURRENT) {
              results = await this.processUploadTasksMaxConcurrent(uploadTasks, googleDriveUploader);
          } else if (processingMode === ProcessingMode.BATCHED) {
              results = await this.processUploadTasksBatched(uploadTasks, googleDriveUploader);
          }
          
          const endTime = Date.now();
          const totalTime = Math.round((endTime - startTime) / 1000);
          
          // Calculate totals
          const totalUploads = results.reduce((sum, result) => sum + result.total, 0);
          const successfulUploads = results.reduce((sum, result) => sum + result.successful, 0);
          const failedUploads = results.reduce((sum, result) => sum + result.failed, 0);
          const skippedUploads = results.reduce((sum, result) => sum + result.skipped, 0);
          
          this.logger.success(
              `${processingMode.toUpperCase()} upload-only mode completed in ${totalTime} seconds:\n` +
              `  Artists: ${results.length} processed\n` +
              `  Uploads: ${successfulUploads}/${totalUploads} successful, ${failedUploads} failed, ${skippedUploads} skipped`
          );
          
          // Clean up old files based on retention policy
          try {
              this.logger.info('Starting cleanup of files older than 3 days...');
              await FileCleanup.cleanupOldFiles(scraperConfig.downloadPath, 3);
              this.logger.info('File cleanup completed');
          } catch (error) {
              this.logger.error('File cleanup failed', error as Error);
          }
          
      } catch (error) {
          this.logger.error('Upload-only execution failed', error as Error);
          throw error;
      }
  }
  
  /**
   * Scan the download directory for existing images
   * @param downloadPath The base download directory path
   * @returns Object mapping artist names to arrays of image file paths
   */
  private async scanExistingImages(downloadPath: string): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    
    try {
      // Ensure the download directory exists
      if (!fs.existsSync(downloadPath)) {
        this.logger.warn(`Download directory not found: ${downloadPath}`);
        return result;
      }
      
      // Read the directory contents
      const items = fs.readdirSync(downloadPath);
      
      // Filter for directories (each directory is an artist)
      const artistDirs = items.filter(item => {
        const itemPath = path.join(downloadPath, item);
        return fs.statSync(itemPath).isDirectory();
      });
      
      if (artistDirs.length === 0) {
        this.logger.warn('No artist directories found in the download path');
        return result;
      }
      
      // Process each artist directory
      for (const artist of artistDirs) {
        const artistPath = path.join(downloadPath, artist);
        const files = fs.readdirSync(artistPath);
        
        // Filter for image files
        const imageFiles = files.filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
        });
        
        if (imageFiles.length > 0) {
          // Map to full file paths
          result[artist] = imageFiles.map(file => path.join(artistPath, file));
        }
      }
      
      return result;
    } catch (error) {
      this.logger.error('Error scanning existing images', error as Error);
      return result;
    }
  }

  /**
   * Process upload tasks using distributed mode
   */
  private async processUploadTasksDistributed(
      uploadTasks: { artist: string; imagePaths: string[] }[], 
      googleDriveUploader: GoogleDriveUploader
  ): Promise<any[]> {
      const maxWorkers = 3;
      const taskQueues: { artist: string; imagePaths: string[] }[][] = [];
      
      // Initialize worker queues
      for (let i = 0; i < maxWorkers; i++) {
          taskQueues.push([]);
      }
      
      // Distribute tasks across queues
      uploadTasks.forEach((task, index) => {
          const queueIndex = index % maxWorkers;
          taskQueues[queueIndex].push(task);
      });
      
      // Log distribution
      taskQueues.forEach((queue, index) => {
          const artists = queue.map(task => task.artist);
          this.logger.info(`Upload Worker ${index + 1} assigned ${queue.length} artists: ${artists.join(', ')}`);
      });
      
      // Process queues concurrently
      const queuePromises = taskQueues.map((queue, workerIndex) => 
          this.processUploadQueue(queue, googleDriveUploader, workerIndex + 1)
      );
      
      const queueResults = await Promise.all(queuePromises);
      
      // Flatten results
      const allResults: any[] = [];
      queueResults.forEach(results => allResults.push(...results));
      
      return allResults;
  }

  /**
   * Process upload tasks using maximum concurrency mode
   */
  private async processUploadTasksMaxConcurrent(
      uploadTasks: { artist: string; imagePaths: string[] }[], 
      googleDriveUploader: GoogleDriveUploader
  ): Promise<any[]> {
      const maxWorkers = 3;
      const taskIndex = { current: 0 };
      const results: any[] = [];
      
      // Create worker promises
      const workerPromises = Array.from({ length: maxWorkers }, async (_, workerIndex) => {
          const workerId = workerIndex + 1;
          const workerResults: any[] = [];
          
          while (taskIndex.current < uploadTasks.length) {
              // Atomically get next task
              const currentIndex = taskIndex.current++;
              if (currentIndex >= uploadTasks.length) break;
              
              const task = uploadTasks[currentIndex];
              
              try {
                  this.logger.info(`Upload Worker ${workerId}: Processing @${task.artist} (${currentIndex + 1}/${uploadTasks.length})`);
                  const result = await googleDriveUploader.batchUpload(task.imagePaths, task.artist);
                  workerResults.push(result);
                  
                  // Small delay
                  await new Promise(resolve => setTimeout(resolve, 500));
                  
              } catch (error) {
                  this.logger.error(`Upload Worker ${workerId}: Failed @${task.artist}`, error as Error);
                  workerResults.push({
                      successful: 0,
                      failed: task.imagePaths.length,
                      skipped: 0,
                      total: task.imagePaths.length
                  });
              }
          }
          
          return workerResults;
      });
      
      const allWorkerResults = await Promise.all(workerPromises);
      allWorkerResults.forEach(workerResults => results.push(...workerResults));
      
      return results;
  }

  /**
   * Process upload tasks using batched mode
   */
  private async processUploadTasksBatched(
      uploadTasks: { artist: string; imagePaths: string[] }[], 
      googleDriveUploader: GoogleDriveUploader
  ): Promise<any[]> {
      const maxWorkers = 3;
      const results: any[] = [];
      
      // Process in batches
      for (let i = 0; i < uploadTasks.length; i += maxWorkers) {
          const batch = uploadTasks.slice(i, i + maxWorkers);
          const batchNumber = Math.floor(i / maxWorkers) + 1;
          const totalBatches = Math.ceil(uploadTasks.length / maxWorkers);
          
          const artists = batch.map(task => task.artist);
          this.logger.info(`Processing upload batch ${batchNumber}/${totalBatches} with ${batch.length} artists: ${artists.join(', ')}`);
          
          // Process batch concurrently
          const batchPromises = batch.map((task, index) => {
              const workerId = index + 1;
              
              return googleDriveUploader.batchUpload(task.imagePaths, task.artist).then(result => {
                  this.logger.info(`Upload Worker ${workerId}: Completed @${task.artist}`);
                  return result;
              }).catch(error => {
                  this.logger.error(`Upload Worker ${workerId}: Failed @${task.artist}`, error as Error);
                  return {
                      successful: 0,
                      failed: task.imagePaths.length,
                      skipped: 0,
                      total: task.imagePaths.length
                  };
              });
          });
          
          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults);
          
          // Add delay between batches
          if (i + maxWorkers < uploadTasks.length) {
              this.logger.info(`Upload batch ${batchNumber} completed. Waiting 4000ms before next batch...`);
              await new Promise(resolve => setTimeout(resolve, 4000));
          }
      }
      
      return results;
  }

  /**
   * Process an upload queue for a single worker
   */
  private async processUploadQueue(
      queue: { artist: string; imagePaths: string[] }[], 
      googleDriveUploader: GoogleDriveUploader, 
      workerId: number
  ): Promise<any[]> {
      const results: any[] = [];
      
      if (queue.length === 0) {
          this.logger.info(`Upload Worker ${workerId}: No artists assigned`);
          return results;
      }
      
      this.logger.info(`Upload Worker ${workerId}: Starting to process ${queue.length} artists`);
      
      for (let i = 0; i < queue.length; i++) {
          const task = queue[i];
          
          try {
              this.logger.info(`Upload Worker ${workerId}: Processing @${task.artist} (${i + 1}/${queue.length})`);
              const result = await googleDriveUploader.batchUpload(task.imagePaths, task.artist);
              results.push(result);
              
              // Add delay between artists
              if (i < queue.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
              }
              
          } catch (error) {
              this.logger.error(`Upload Worker ${workerId}: Failed to process @${task.artist}`, error as Error);
              results.push({
                  successful: 0,
                  failed: task.imagePaths.length,
                  skipped: 0,
                  total: task.imagePaths.length
              });
          }
      }
      
      this.logger.success(`Upload Worker ${workerId}: Completed processing ${queue.length} artists`);
      return results;
  }
  
  /**
   * Debug Google Drive configuration and permissions
   * Runs diagnostics on the Google Drive setup
   */
  public async debugGoogleDrive(): Promise<void> {
    this.logger.info('=== Google Drive Debug Mode ===');
    
    try {
      // Get Google Drive configuration
      const googleDriveConfig = this.configManager.getGoogleDriveConfig();
      
      // Check if Google Drive is enabled
      if (!googleDriveConfig.enableUpload) {
        this.logger.error('Google Drive upload is not enabled in configuration');
        this.logger.info('Set GOOGLE_DRIVE_ENABLED=true in your config/.env file');
        return;
      }
      
      this.logger.info('Google Drive Configuration:');
      this.logger.info(`- Upload Enabled: ${googleDriveConfig.enableUpload}`);
      this.logger.info(`- Credentials Path: ${googleDriveConfig.credentialsPath}`);
      this.logger.info(`- Root Folder ID: ${googleDriveConfig.rootFolderId}`);
      
      // Check if credentials file exists
      if (!fs.existsSync(googleDriveConfig.credentialsPath)) {
        this.logger.error(`Google Drive credentials file not found at: ${googleDriveConfig.credentialsPath}`);
        this.logger.info('Make sure you have placed your Service Account JSON file at this location');
        return;
      }
      
      // Check root folder ID
      if (!googleDriveConfig.rootFolderId) {
        this.logger.error('Google Drive root folder ID is empty');
        this.logger.info('Set GOOGLE_DRIVE_ROOT_FOLDER_ID in your config/.env file');
        return;
      }
      
      // Validate folder ID format
      const folderIdPattern = /^[a-zA-Z0-9_-]+$/;
      if (!folderIdPattern.test(googleDriveConfig.rootFolderId)) {
        this.logger.warn(`Root folder ID may be invalid: ${googleDriveConfig.rootFolderId}`);
        this.logger.info('Folder ID should be a string of letters and numbers without slashes or special characters');
      }
      
      this.logger.info('Initializing Google Drive uploader for testing...');
      
      // Initialize the Google Drive uploader
      try {
        this.googleDriveUploader = new GoogleDriveUploader(
          googleDriveConfig.credentialsPath,
          googleDriveConfig.rootFolderId
        );
        
        // Run the debug access tests
        await this.googleDriveUploader.debugFolderAccess();
      } catch (error) {
        this.logger.error('Google Drive initialization failed', error as Error);
        
        // Provide helpful advice
        this.logger.info('\nTroubleshooting Steps:');
        this.logger.info('1. Check that your credentials file contains valid JSON');
        this.logger.info('2. Verify your folder ID is correct (copy from Google Drive URL)');
        this.logger.info('3. Ensure the service account email has been added to the folder with Editor permission');
        this.logger.info('4. Verify the Google Drive API is enabled in your Google Cloud project');
      }
    } catch (error) {
      this.logger.error('Failed to debug Google Drive', error as Error);
    }
  }

  /**
   * Log detailed results from worker processing
   * Add this as a new private method in TwitterImageScraper class
   */
  private logWorkerResults(results: WorkerResult[]): void {
      this.logger.info('\n=== WORKER PROCESSING RESULTS ===');
      
      for (const result of results) {
          if (result.success) {
              if (result.error) {
                  this.logger.warn(`@${result.artist}: ${result.error}`);
              } else {
                  const downloadInfo = `${result.stats.successful}/${result.stats.total} downloads`;
                  const uploadInfo = result.uploadResult ? 
                      `, ${result.uploadResult.successful}/${result.uploadResult.total} uploads` : '';
                  this.logger.success(`@${result.artist}: ${downloadInfo}${uploadInfo}`);
              }
          } else {
              this.logger.error(`@${result.artist}: ${result.error || 'Unknown error'}`);
          }
      }
      
      this.logger.info('=== END WORKER RESULTS ===\n');
  }
  
  /**
   * Clean up resources
   */
  public async cleanup(): Promise<void> {
    this.logger.info('Cleaning up resources...');
    
    if (this.page) {
      await this.page.close();
    }
    
    if (this.context) {
      await this.context.close();
    }
    
    if (this.browser) {
      await this.browser.close();
    }
    
    this.logger.info('Cleanup completed');
  }
}

/**
 * Define CLI argument types
 */
interface CliArgs {
    'scrape-only'?: boolean;
    scrapeOnly?: boolean;
    's'?: boolean;
    'upload-only'?: boolean;
    uploadOnly?: boolean;
    'u'?: boolean;
    'debug-drive'?: boolean;
    debugDrive?: boolean;
    'd'?: boolean;
    'processing-mode'?: string;
    processingMode?: string;
    'm'?: string;
    'help'?: boolean;
    'h'?: boolean;
    'version'?: boolean;
    'v'?: boolean;
    [key: string]: unknown;
}

async function main(): Promise<void> {
    // Parse command line arguments
    const argv = yargs(hideBin(process.argv))
        .scriptName('twitter-image-scraper')
        .usage('$0 [options]')
        .option('scrape-only', {
            alias: 's',
            type: 'boolean',
            description: 'Run in scrape-only mode (no Google Drive upload)'
        })
        .option('upload-only', {
            alias: 'u',
            type: 'boolean',
            description: 'Run in upload-only mode (upload existing images without scraping)'
        })
        .option('debug-drive', {
            alias: 'd',
            type: 'boolean',
            description: 'Test Google Drive configuration and permissions'
        })
        .option('processing-mode', {
            alias: 'm',
            type: 'string',
            choices: ['distributed', 'max_concurrent', 'batched'],
            default: 'distributed',
            description: 'Worker processing mode: distributed (round-robin), max_concurrent (grab next), batched (controlled batches)'
        })
        .help()
        .alias('help', 'h')
        .version()
        .alias('version', 'v')
        .strict()
        .parseSync() as CliArgs;
        
    // If help or version was requested, exit early (yargs will have printed the info)
    if (argv.help || argv.h || argv.version || argv.v) {
        process.exit(0);
    }

    const scraper = new TwitterImageScraper();
    
    try {
        const isScrapeOnly = argv['scrape-only'] || argv.scrapeOnly || argv.s;
        const isUploadOnly = argv['upload-only'] || argv.uploadOnly || argv.u;
        const isDebugDrive = argv['debug-drive'] || argv.debugDrive || argv.d;
        
        // Get processing mode
        const processingModeStr = argv['processing-mode'] || argv.processingMode || argv.m || 'distributed';
        const processingMode = processingModeStr as ProcessingMode;
        
        // Debug mode takes precedence
        if (isDebugDrive) {
            console.log('Running in Google Drive debug mode...');
            await scraper.debugGoogleDrive();
            process.exit(0);
            return;
        }
        
        // Check for conflicting flags
        if (isScrapeOnly && isUploadOnly) {
            console.error('Error: Cannot use both --scrape-only and --upload-only flags together');
            process.exit(1);
        }
        
        // Initialize scraper (not needed for upload-only mode)
        if (!isUploadOnly) {
            await scraper.initialize();
        }
        
        // Determine which mode to run
        if (isScrapeOnly) {
            console.log(`Running in scrape-only mode with ${processingMode} processing...`);
            await scraper.runScrapeOnly(processingMode);
        } else if (isUploadOnly) {
            console.log(`Running in upload-only mode with ${processingMode} processing...`);
            await scraper.runUploadOnly(processingMode); // Pass processing mode
        } else {
            console.log(`Running in full mode (scrape + upload) with ${processingMode} processing...`);
            await scraper.run(processingMode);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the main function if this file is being executed directly
if (require.main === module) {
  main();
}

export { TwitterImageScraper };
