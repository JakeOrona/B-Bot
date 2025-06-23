/**
 * Test script to verify the fixes to the logging architecture
 * Run with: npm run test:stress-log
 */

import { ProgressLogger, WorkerContext } from '../utilities/ProgressLogger';

async function testStressedLogging(): Promise<void> {
    // Initialize logger with concise mode and grouped bars
    const logger = ProgressLogger.getInstance({
        logMode: 'concise',
        showProgressBars: true,
        logToFile: true,
        separateLogFiles: true,
        enableGroupedBars: true,
        refreshInterval: 500, // Use longer refresh interval
        bufferSize: 12 // Larger buffer size for more context
    });
    
    // Log starting message
    await logger.section('STRESS TEST LOGGING');
    await logger.info('Starting stress test of advanced logging architecture');
    
    // Create several worker contexts
    const workers = [
        { workerId: 1, username: 'artist1', imageCount: 50 },
        { workerId: 2, username: 'artist2', imageCount: 75 },
        { workerId: 3, username: 'artist3', imageCount: 100 },
        { workerId: 4, username: 'artist4', imageCount: 125 }
    ];
    
    // Start concurrent worker processes to simulate heavy load
    const workerPromises = workers.map(worker => simulateWorkerProcess(worker, logger));
    
    // Run all processes concurrently
    await Promise.all(workerPromises);
    
    // Final message
    await logger.section('TEST COMPLETE');
    await logger.success('Stress test complete - check output quality');
}

async function simulateWorkerProcess(
    worker: { workerId: number, username: string, imageCount: number },
    logger: ProgressLogger
): Promise<void> {
    const workerContext: WorkerContext = { workerId: worker.workerId, username: worker.username };
    
    // Log worker start with section
    await logger.section(`Worker ${worker.workerId} Start`, workerContext);
    await logger.info(`Starting processing for @${worker.username}`, undefined, undefined, workerContext);
    
    // Create scroll progress bar
    const scrollId = `scroll-${worker.username}`;
    await logger.createProgressBar(scrollId, 100, 'Scrolling', worker.username, workerContext);
    
    // Simulate scrolling with frequent updates and logs
    for (let i = 1; i <= 100; i += 3) {
        // Update progress
        await logger.updateProgress(scrollId, i, undefined, workerContext);
        
        // Add occasional log messages
        if (i % 10 === 0) {
            await logger.info(`Scrolled ${i} times for @${worker.username}`, undefined, undefined, workerContext);
        }
        
        // Add random warnings
        if (i === 33 || i === 66) {
            await logger.warn(`Rate limit warning at ${i} scrolls`, workerContext);
        }
        
        // Random delay
        await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
    }
    
    // Complete scrolling progress
    await logger.completeProgress(scrollId, `Found ${worker.imageCount} images for @${worker.username}`, workerContext);
    
    // Create download progress bar
    const downloadId = `download-${worker.username}`;
    await logger.createProgressBar(downloadId, worker.imageCount, 'Downloading', worker.username, workerContext);
    
    // Simulate downloading with frequent updates
    for (let i = 1; i <= worker.imageCount; i++) {
        // Update progress
        await logger.updateProgress(downloadId, i, undefined, workerContext);
        
        // Add occasional log messages
        if (i % 15 === 0) {
            await logger.info(`Downloaded ${i}/${worker.imageCount} images for @${worker.username}`, undefined, undefined, workerContext);
        }
        
        // Simulate error
        if (i === Math.floor(worker.imageCount / 2) && worker.workerId === 2) {
            await logger.error(`Failed to download image ${i}`, new Error('Network timeout'), undefined, workerContext);
            // Small delay for error recovery
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // Small delay
        await new Promise(resolve => setTimeout(resolve, 30 + Math.random() * 50));
    }
    
    // Complete download progress
    await logger.completeProgress(downloadId, `Downloaded ${worker.imageCount} images for @${worker.username}`, workerContext);
    
    // Create upload progress bar (multiple batches for realism)
    const batchSize = 20;
    const batchCount = Math.ceil(worker.imageCount / batchSize);
    
    for (let batch = 1; batch <= batchCount; batch++) {
        const batchTotal = (batch < batchCount) ? batchSize : (worker.imageCount % batchSize) || batchSize;
        const uploadId = `upload-${worker.username}-batch${batch}`;
        
        await logger.createProgressBar(uploadId, batchTotal, 'Uploading', worker.username, workerContext);
        
        // Simulate uploads
        for (let i = 1; i <= batchTotal; i++) {
            await logger.updateProgress(uploadId, i, undefined, workerContext);
            
            // Small delay
            await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
        }
        
        // Complete batch
        await logger.completeProgress(
            uploadId, 
            `Uploaded batch ${batch}/${batchCount} (${batchTotal} images) for @${worker.username}`, 
            workerContext
        );
    }
    
    // Section for completion
    await logger.section(`Worker ${worker.workerId} Complete`, workerContext);
    await logger.success(`Finished processing all ${worker.imageCount} images for @${worker.username}`, undefined, workerContext);
    
    // Clean up worker bars
    await logger.cleanupWorkerBars(worker.workerId);
}

// Run the test
testStressedLogging().catch(error => {
    console.error('Test failed with error:', error);
    process.exit(1);
});
