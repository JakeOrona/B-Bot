/**
 * Progress Logger Demo
 * 
 * This script demonstrates the features of the ProgressLogger:
 * - Multiple progress bars for concurrent operations
 * - Concise vs. verbose logging modes
 * - Different message types (info, success, error, warning)
 * 
 * Run with:
 *   npm run demo:logger
 * 
 * Toggle between concise and verbose modes by setting LOG_MODE in .env
 */

import { ConfigManager } from '../utilities/ConfigManager';
import { ProgressLogger } from '../utilities/ProgressLogger';
import colors from 'colors';
import path from 'path';
import fs from 'fs';

// Demo configuration
const DEMO_ARTISTS = ['artist1', 'artist2', 'artist3'];
const DEMO_FILES_PER_ARTIST = 10;
const DEMO_UPLOAD_BATCH_SIZE = 5;

/**
 * Main demo class
 */
class ProgressLoggerDemo {
  private configManager: ConfigManager;
  private progressLogger: ProgressLogger;
  
  constructor() {
    // Initialize configuration
    this.configManager = ConfigManager.getInstance();
    
    // Get progress logger configuration from environment
    const progressConfig = this.configManager.getProgressConfig();
    
    // Initialize progress logger
    this.progressLogger = ProgressLogger.getInstance(progressConfig);
  }
  
  /**
   * Run the demo
   */
  async run(): Promise<void> {
    try {
      // Display header
      console.log(colors.cyan('\n========================================'));
      console.log(colors.cyan('  PROGRESS LOGGER DEMONSTRATION'));
      console.log(colors.cyan('========================================\n'));
      
      // Show current configuration
      this.progressLogger.info(`Log mode: ${colors.yellow(this.configManager.getProgressConfig().logMode)}`);
      this.progressLogger.info(`Show progress bars: ${colors.yellow(String(this.configManager.getProgressConfig().showProgressBars))}`);
      this.progressLogger.info(`Log to file: ${colors.yellow(String(this.configManager.getProgressConfig().logToFile))}`);
      
      // Demonstrate different message types
      this.progressLogger.section('MESSAGE TYPES DEMONSTRATION');
      this.progressLogger.info('This is an informational message');
      this.progressLogger.success('This is a success message');
      this.progressLogger.warn('This is a warning message');
      this.progressLogger.error('This is an error message');
      
      try {
        throw new Error('Sample error details');
      } catch (error) {
        this.progressLogger.error('This is an error message with details', error as Error);
      }
      
      // Demonstrate progress bars
      this.progressLogger.section('PROGRESS BAR DEMONSTRATION');
      
      // Simulate processing multiple artists
      for (const artist of DEMO_ARTISTS) {
        await this.simulateProcessArtist(artist);
        // Add a small delay between artists
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Show final summary
      this.progressLogger.section('DEMO COMPLETED');
      this.progressLogger.success(`Processed ${DEMO_ARTISTS.length} artists with ${DEMO_ARTISTS.length * DEMO_FILES_PER_ARTIST} total images`);
      
      // Cleanup
      this.progressLogger.stopAll();
      
    } catch (error) {
      this.progressLogger.error('Demo failed', error as Error);
    }
  }
  
  /**
   * Simulate processing a single artist
   */
  private async simulateProcessArtist(username: string): Promise<void> {
    // Create a unique ID for download progress tracking
    const downloadProgressId = `download_${username}`;
    
    // Create a progress bar for downloads
    this.progressLogger.createProgressBar(
      downloadProgressId,
      DEMO_FILES_PER_ARTIST,
      'Downloading',
      username
    );
    
    this.progressLogger.info(`Starting to process artist: ${username}`);
    
    // Simulate image downloads
    for (let i = 0; i < DEMO_FILES_PER_ARTIST; i++) {
      // Simulate download delay
      await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));
      
      // Update progress
      this.progressLogger.updateProgress(downloadProgressId, i + 1);
      
      // Add some detailed info messages periodically
      if (i % 3 === 0) {
        this.progressLogger.info(`Downloaded image ${i + 1}/${DEMO_FILES_PER_ARTIST} for ${username}`, downloadProgressId, i + 1);
      }
      
      // Simulate a random error
      if (Math.random() < 0.1) {
        this.progressLogger.warn(`Retrying download for image ${i + 1} due to rate limiting`);
      }
    }
    
    // Simulate upload process with batches
    const totalBatches = Math.ceil(DEMO_FILES_PER_ARTIST / DEMO_UPLOAD_BATCH_SIZE);
    
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchSize = Math.min(DEMO_UPLOAD_BATCH_SIZE, DEMO_FILES_PER_ARTIST - batch * DEMO_UPLOAD_BATCH_SIZE);
      const uploadProgressId = `upload_${username}_batch${batch}`;
      
      // Create a progress bar for this upload batch
      this.progressLogger.createProgressBar(
        uploadProgressId,
        batchSize,
        'Uploading',
        username
      );
      
      this.progressLogger.info(`Starting batch upload ${batch + 1}/${totalBatches} (${batchSize} files) for ${username}`);
      
      // Simulate file uploads
      for (let i = 0; i < batchSize; i++) {
        // Simulate upload delay
        await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 200));
        
        // Update progress
        this.progressLogger.updateProgress(uploadProgressId, i + 1);
      }
      
      // Complete the progress bar for this batch
      this.progressLogger.completeProgress(
        uploadProgressId,
        `Batch ${batch + 1}/${totalBatches} uploaded for ${username}`
      );
      
      // Show success message
      this.progressLogger.success(
        `Completed batch ${batch + 1}/${totalBatches} upload for ${username}: ${batchSize}/${batchSize} files`
      );
    }
    
    // Complete the download progress bar
    this.progressLogger.completeProgress(
      downloadProgressId,
      `All images processed for ${username}`
    );
    
    // Show final success message for this artist
    this.progressLogger.success(
      `Completed processing ${username}: ${DEMO_FILES_PER_ARTIST} images downloaded and uploaded`
    );
  }
}

// Run the demo
(async () => {
  const demo = new ProgressLoggerDemo();
  await demo.run();
})().catch(error => {
  console.error('Demo failed:', error);
  process.exit(1);
});
