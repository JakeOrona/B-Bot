/**
 * Test script to verify the fixes to the extraction worker concurrency
 * This simulates running the scraper with multiple profiles to verify
 * that workers properly claim different profiles instead of competing
 * for the same one.
 */

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { ScraperConfig } from '../interfaces/ScraperTypes';
import { ConcurrentProcessingConfig } from '../interfaces/ConcurrentTypes';
import { ConcurrentProfileManager } from '../utilities/ConcurrentProfileManager';
import { ProfileQueue } from '../utilities/ProfileQueue';
import { Logger } from '../utilities/Logger';
import { ProgressLogger } from '../utilities/ProgressLogger';

// Test configuration
const config: ScraperConfig = {
  username: 'test-user',
  password: 'test-password',
  downloadPath: './test-downloads',
  outputFormat: 'folders',  
  rateLimitDelay: 1000,
  maxScrolls: 10,
  headless: false,
  slowMo: 100,
  proxyUrl: '',
  ignoreLoginFlow: true // Skip actual Twitter login for test
};

const concurrentConfig: ConcurrentProcessingConfig = {
  enabled: true,
  maxConcurrentProfiles: 3,
  extractionTimeoutMs: 60000, // 1 minute timeout for tests
  queueMaxSize: 100
};

// Test accounts
const testProfiles = [
  'Macbaconai',
  'ultra_arcane',
  'babs69420',
  'SpaceTitans42'
];

async function runConcurrencyTest() {
  const logger = Logger.getInstance();
  const progressLogger = ProgressLogger.getInstance({
    logMode: 'verbose',
    showProgressBars: true,
    logToFile: true
  });
  
  // Set up browser
  logger.info('Starting concurrency test with test profiles');
  logger.info(`Test profiles: ${testProfiles.join(', ')}`);
  
  const browser = await chromium.launch({ 
    headless: config.headless,
    slowMo: config.slowMo
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // Initialize profile manager for concurrent processing
    const concurrentManager = new ConcurrentProfileManager(
      browser,
      context,
      page,
      config,
      concurrentConfig
    );
    
    // Start processing
    logger.info('Starting concurrent processing test');
    await concurrentManager.startProcessing(testProfiles);
    
    // Wait for processing to complete or timeout
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const queue = new ProfileQueue(); // Using profile queue's static instance
        if (queue.isAllDone()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 5000);
      
      // Safety timeout
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 120000); // 2 minutes max
    });
    
    logger.info('Test complete, shutting down');
  } catch (error) {
    logger.error('Test failed with error', error as Error);
  } finally {
    // Clean up
    await browser.close();
    logger.info('Test finished, browser closed');
  }
}

// Run the test
runConcurrencyTest().catch(console.error);
