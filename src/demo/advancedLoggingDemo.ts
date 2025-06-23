/**
 * Test script to demonstrate the new logging architecture
 * 
 * Run with:
 *   npm run test:logging
 * 
 * This script simulates multiple workers processing different profiles
 * to demonstrate worker context logging and progress bars.
 */

import { ProgressLogger } from '../utilities/ProgressLogger';
import { ConfigManager } from '../utilities/ConfigManager';
import colors from 'colors';

// Mock worker data for demonstration
const mockWorkers = [
  { workerId: 1, username: 'user1', imageCount: 30 },
  { workerId: 2, username: 'user2', imageCount: 45 },
  { workerId: 3, username: 'user3', imageCount: 20 }
];

// Main test function
async function testLogging() {
  console.log(colors.cyan('\n=== ADVANCED LOGGING ARCHITECTURE DEMO ===\n'));
  
  // Get configuration
  const configManager = ConfigManager.getInstance();
  const progressConfig = configManager.getProgressConfig();
  
  // Force enable separate log files for demonstration
  progressConfig.separateLogFiles = true;
  
  // Initialize logger
  const logger = ProgressLogger.getInstance(progressConfig);
  
  // Log configuration details
  await logger.info(`Log mode: ${colors.yellow(progressConfig.logMode)}`);
  await logger.info(`Progress bars: ${colors.yellow(String(progressConfig.showProgressBars))}`);
  await logger.info(`Log to file: ${colors.yellow(String(progressConfig.logToFile))}`);
  await logger.info(`Separate log files: ${colors.yellow(String(progressConfig.separateLogFiles))}`);
  
  // Start section for worker processing
  await logger.section('STARTING WORKER PROCESSING');
  
  // Array to hold all promises for operations
  const promises = [];
  
  // Process each mock worker
  for (const worker of mockWorkers) {
    // Create worker context
    const workerContext = { 
      workerId: worker.workerId, 
      username: worker.username 
    };
    
    // Log worker startup
    await logger.info(`Starting extraction for worker ${worker.workerId}`, undefined, undefined, workerContext);
    
    // Create all three types of progress bars
    const scrollProgressId = `scroll-${worker.username}`;
    const downloadProgressId = `download-${worker.username}`;
    const uploadProgressId = `upload-${worker.username}-batch1`;
    
    // Create progress bars
    await logger.createProgressBar(scrollProgressId, 250, 'Scrolling', worker.username, workerContext);
    await logger.createProgressBar(downloadProgressId, worker.imageCount, 'Downloading', worker.username, workerContext);
    await logger.createProgressBar(uploadProgressId, worker.imageCount, 'Uploading', worker.username, workerContext);
    
    // Create simulation promise for this worker
    const workerPromise = simulateWorkerProcess(worker, logger, scrollProgressId, downloadProgressId, uploadProgressId);
    promises.push(workerPromise);
  }
  
  // Wait for all workers to complete
  await Promise.all(promises);
  
  // Final section
  await logger.section('DEMO COMPLETED');
  await logger.success('All workers completed successfully');
  
  // Stop all progress bars
  await logger.stopAll();
}

// Function to simulate worker processing
async function simulateWorkerProcess(
  worker: { workerId: number; username: string; imageCount: number },
  logger: ProgressLogger,
  scrollProgressId: string,
  downloadProgressId: string,
  uploadProgressId: string
): Promise<void> {
  // Worker context for logging
  const workerContext = { 
    workerId: worker.workerId, 
    username: worker.username 
  };
  
  // Simulate scrolling
  for (let i = 1; i <= 250; i++) {
    // Only update every few scrolls for demo clarity
    if (i % 10 === 0) {
      await logger.updateProgress(scrollProgressId, i, undefined, workerContext);
      
      // Add occasional log messages
      if (i % 50 === 0) {
        await logger.info(`Scrolled ${i} times for ${worker.username}`, undefined, undefined, workerContext);
      }
    }
    
    // Add small delay
    await new Promise(resolve => setTimeout(resolve, 10 + (worker.workerId * 5)));
  }
  
  // Complete scrolling with success
  await logger.completeProgress(
    scrollProgressId,
    `Found ${worker.imageCount} images for ${worker.username}`,
    workerContext
  );
  
  // Simulate downloading
  for (let i = 1; i <= worker.imageCount; i++) {
    await logger.updateProgress(downloadProgressId, i, undefined, workerContext);
    
    // Add occasional log messages
    if (i % 10 === 0) {
      await logger.info(`Downloaded ${i}/${worker.imageCount} images for ${worker.username}`, undefined, undefined, workerContext);
    }
    
    // Simulate random errors for demonstration
    if (i === Math.floor(worker.imageCount / 3) && worker.workerId === 2) {
      await logger.warn(`Rate limit detected while downloading image ${i}`, workerContext);
    }
    
    // Add small delay that varies by worker
    await new Promise(resolve => setTimeout(resolve, 50 + (worker.workerId * 10)));
  }
  
  // Complete downloading with success
  await logger.completeProgress(
    downloadProgressId,
    `Downloaded all ${worker.imageCount} images for ${worker.username}`,
    workerContext
  );
  
  // Simulate uploading
  for (let i = 1; i <= worker.imageCount; i++) {
    await logger.updateProgress(uploadProgressId, i, undefined, workerContext);
    
    // Add small delay that varies by worker
    await new Promise(resolve => setTimeout(resolve, 50 + (worker.workerId * 10)));
  }
  
  // Complete uploading with success
  await logger.completeProgress(
    uploadProgressId,
    `Uploaded all ${worker.imageCount} images for ${worker.username}`,
    workerContext
  );
  
  // Final worker completion message
  await logger.success(`Worker ${worker.workerId} completed processing @${worker.username}`, undefined, workerContext);
}

// Run the test
testLogging().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
