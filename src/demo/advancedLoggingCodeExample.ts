/**
 * Example code showing how to use the advanced logging architecture
 */

import { AdvancedProgressConfig, ProgressConfig, ProgressLogger, WorkerContext } from '../utilities/ProgressLogger';
import { Logger } from '../utilities/Logger';

// Example 1: Basic initialization with advanced options
async function basicExample() {
    // Initialize with advanced config
    const config: ProgressConfig & Partial<AdvancedProgressConfig> = {
        logMode: 'concise',
        showProgressBars: true,
        logToFile: true,
        separateLogFiles: true,
        
        // Advanced options
        enableGroupedBars: true,
        bufferSize: 8,
        refreshInterval: 100
    };
    
    const logger = ProgressLogger.getInstance(config);
    
    // Log a section header
    await logger.section('INITIALIZATION');
    
    // Regular logging
    await logger.info('Starting Twitter image scraper');
    await logger.info('Loaded configuration');
    
    // Simulate an error
    try {
        throw new Error('Failed to connect to Twitter');
    } catch (error) {
        await logger.error('Connection error', error as Error);
    }
}

// Example 2: Working with single worker context
async function singleWorkerExample() {
    const logger = ProgressLogger.getInstance();
    
    // Create worker context
    const workerContext: WorkerContext = {
        workerId: 1,
        username: 'artist1'
    };
    
    // Start a section for this worker
    await logger.section('WORKER #1 PROCESSING', workerContext);
    
    // Log information with worker context
    await logger.info('Starting profile extraction', undefined, undefined, workerContext);
    
    // Create a scrolling progress bar
    const scrollProgressId = `scroll-${workerContext.username}`;
    await logger.createProgressBar(scrollProgressId, 250, 'Scrolling', workerContext.username!, workerContext);
    
    // Simulate scrolling
    for (let i = 1; i <= 100; i += 10) {
        await logger.updateProgress(scrollProgressId, i, undefined, workerContext);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Complete the progress bar
    await logger.completeProgress(scrollProgressId, 'Found 30 images', workerContext);
    
    // Create a downloading progress bar
    const downloadProgressId = `download-${workerContext.username}`;
    await logger.createProgressBar(downloadProgressId, 30, 'Downloading', workerContext.username!, workerContext);
    
    // Simulate downloading
    for (let i = 1; i <= 30; i++) {
        await logger.updateProgress(downloadProgressId, i, undefined, workerContext);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Complete downloading
    await logger.completeProgress(downloadProgressId, 'Downloaded 30 images', workerContext);
    
    // Clean up worker resources
    if (workerContext.workerId !== undefined) {
        await logger.cleanupWorkerBars(workerContext.workerId);
    }
}

// Example 3: Multiple concurrent workers
async function multiWorkerExample() {
    const logger = ProgressLogger.getInstance();
    
    // Create multiple worker contexts
    const workers = [
        { workerId: 1, username: 'artist1', imageCount: 30 },
        { workerId: 2, username: 'artist2', imageCount: 45 },
        { workerId: 3, username: 'artist3', imageCount: 20 }
    ];
    
    // Start all workers (in parallel)
    const promises = workers.map(worker => 
        simulateWorkerProcess(worker.workerId, worker.username, worker.imageCount));
    
    // Wait for all workers to complete
    await Promise.all(promises);
    
    // Final section
    await logger.section('ALL WORKERS COMPLETED');
    await logger.success('Processing complete');
    
    // Stop all progress bars and clean up
    await logger.stopAll();
}

// Helper function to simulate a worker process
async function simulateWorkerProcess(workerId: number, username: string, imageCount: number): Promise<void> {
    const logger = ProgressLogger.getInstance();
    const workerContext: WorkerContext = { workerId, username };
    
    // Log worker start
    await logger.info(`Starting worker ${workerId} for @${username}`, undefined, undefined, workerContext);
    
    // Progress bar IDs
    const scrollProgressId = `scroll-${username}`;
    const downloadProgressId = `download-${username}`;
    
    // Create progress bars
    await logger.createProgressBar(scrollProgressId, 100, 'Scrolling', username, workerContext);
    
    // Simulate scrolling
    for (let i = 1; i <= 100; i += 5) {
        await logger.updateProgress(scrollProgressId, i, undefined, workerContext);
        await new Promise(resolve => setTimeout(resolve, 50 + (workerId * 10)));
    }
    
    await logger.completeProgress(scrollProgressId, `Found ${imageCount} images for ${username}`, workerContext);
    
    // Create download bar
    await logger.createProgressBar(downloadProgressId, imageCount, 'Downloading', username, workerContext);
    
    // Simulate downloading
    for (let i = 1; i <= imageCount; i++) {
        await logger.updateProgress(downloadProgressId, i, undefined, workerContext);
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Add some warnings randomly
        if (i === Math.floor(imageCount / 2) && workerId === 2) {
            await logger.warn('Rate limit detected, waiting before continuing', workerContext);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    await logger.completeProgress(downloadProgressId, `Downloaded ${imageCount} images`, workerContext);
    await logger.success(`Worker ${workerId} completed processing @${username}`, undefined, workerContext);
    
    // Clean up
    await logger.cleanupWorkerBars(workerId);
}

// Export functions for use in other demos
export {
    basicExample,
    singleWorkerExample,
    multiWorkerExample
};

// Run examples if called directly
if (require.main === module) {
    (async () => {
        try {
            console.log('\n=== BASIC EXAMPLE ===\n');
            await basicExample();
            
            console.log('\n=== SINGLE WORKER EXAMPLE ===\n');
            await singleWorkerExample();
            
            console.log('\n=== MULTI WORKER EXAMPLE ===\n');
            await multiWorkerExample();
        } catch (error) {
            console.error('Demo failed:', error);
        }
    })();
}
