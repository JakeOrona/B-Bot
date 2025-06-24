# Advanced Logging Architecture

This document explains the advanced logging architecture in B-Bot, which provides a clear and organized display of concurrent scraping operations across multiple workers.

## Features

- **Dual Logging Modes**:
  - **Concise**: Shows organized progress bars with minimal output (good for production use)
  - **Verbose**: Shows detailed log messages (good for debugging)

- **Grouped Progress Bars by Worker**: All progress bars are grouped by worker for better visual organization
  - Scrolling progress
  - Downloading progress
  - Uploading progress (including multiple batch uploads)

- **Log Buffer Display**: Shows recent log messages in a dedicated section below progress bars

- **Dual File Logging**:
  - Verbose logs: `logs/scraper-${timestamp}.log`
  - Concise logs: `logs/scraper-${timestamp}-concise.log`
  
- **Worker Context in All Output**: All logs include worker identification:
  - `[Worker#1:@username]` format for all messages
  - Thread-safe console output

- **Visual Organization**: 
  - Dedicated sections for worker progress and recent logs
  - Color-coded output for different message types
  - Clear bar and log separation to prevent interleaving

## Configuration Options

Configure the logger through environment variables in `config/.env`:

```
# Basic Logging Configuration
LOG_MODE=concise              # 'concise' or 'verbose'
SHOW_PROGRESS_BARS=true       # Enable/disable progress bars
LOG_TO_FILE=true              # Output logs to file
SEPARATE_LOG_FILES=true       # Use separate files for concise and verbose logs

# Advanced Logging Configuration
ENABLE_GROUPED_BARS=true      # Group progress bars by worker
LOG_BUFFER_SIZE=8             # Number of log entries to display in Recent Logs section
LOG_REFRESH_INTERVAL=100      # UI refresh interval in milliseconds
```

## Example Terminal Output with Advanced Logging

With grouped bars and log buffer enabled, the terminal output will be organized in sections:

```
=== Twitter/X Image Scraper Advanced Logging ===
[2025-06-23T19:18:47.013Z] Mode: concise | Progress bars: enabled | Workers: 3

=== Worker Progress ===
[Worker#1:@user1] Scrolling:    [██████████████████ 45/250 18% ETA: 15s]
[Worker#1:@user1] Downloading:  [████████████████ 12/30 40% ETA: 8s]
[Worker#2:@user2] Scrolling:    [████████████████████████ 60/250 24% ETA: 12s]
[Worker#2:@user2] Downloading:  [██████████ 8/45 18% ETA: 18s]
[Worker#3:@user3] Scrolling:    [████████████████████████████ 70/250 28% ETA: 10s]

=== Recent Logs ===
[19:18:50] [INFO] [Worker#1:@user1] Starting image extraction
[19:18:51] [SUCCESS] [Worker#2:@user2] Found 45 images after scrolling
[19:18:52] [WARN] [Worker#1:@user1] Rate limit detected, retrying
[19:18:53] [SUCCESS] [Worker#3:@user3] Completed scrolling phase
```

## Testing the Advanced Logger

Use the included demo script to see the advanced logging in action:

```bash
# Test with advanced logging features
npm run test:logging

# Test with verbose mode
node test-logger.js --verbose

# Test with verbose mode and no progress bars
node test-logger.js --verbose --no-bars

# Show all options
node test-logger.js --help
```

## Code Usage

### Basic Usage

```typescript
import { ConfigManager } from './utilities/ConfigManager';
import { ProgressLogger } from './utilities/ProgressLogger';

// Get progress logger configuration
const configManager = ConfigManager.getInstance();
const progressConfig = configManager.getProgressConfig();

// Initialize the logger
const logger = ProgressLogger.getInstance(progressConfig);

// Use different message types
logger.info('This is an informational message');
logger.success('Operation completed successfully');
logger.warn('This is a warning message');
logger.error('An error occurred', error);
logger.section('STARTING NEW SECTION');
```

### Using Progress Bars

```typescript
// Create a unique ID for this operation
const progressId = 'download_artist123';

// Create a progress bar with total items
logger.createProgressBar(
  progressId, 
  100,               // Total items
  'Downloading',     // Operation type
  'artist123'        // Artist name
);

// Update the progress as operations complete
for (let i = 0; i < 100; i++) {
  // Do work...
  
  // Update the progress bar
  logger.updateProgress(progressId, i + 1);
  
  // Optionally include info messages that will be displayed differently based on mode
  logger.info(`Processing item ${i+1}/100`, progressId, i+1);
}

// Mark the progress as complete when done
logger.completeProgress(progressId, 'All files downloaded for artist123');
```

### Advanced Usage with Worker Context

```typescript
// Define worker context (workerId and optional username)
const workerContext = { workerId: 1, username: 'artist1' };

// Create multiple progress bars for concurrent operations with worker context
logger.createProgressBar('scroll-artist1', 250, 'Scrolling', 'artist1', workerContext);
logger.createProgressBar('download-artist1', 50, 'Downloading', 'artist1', workerContext);
logger.createProgressBar('upload-artist1-batch1', 25, 'Uploading', 'artist1', workerContext);

// Update them independently with worker context
logger.updateProgress('scroll-artist1', 10, undefined, workerContext);
logger.updateProgress('download-artist1', 10, undefined, workerContext);
logger.updateProgress('upload-artist1-batch1', 5, undefined, workerContext);

// Log messages with worker context
logger.info('Processing profile data', undefined, undefined, workerContext);
logger.warn('Rate limiting detected, slowing down', workerContext);

// Complete them when finished with worker context
logger.completeProgress('upload-artist1-batch1', 'Upload completed for artist1', workerContext);
logger.success('All operations completed successfully', undefined, workerContext);

// Clean up when all operations are done
logger.stopAll();
```

## Running the Demo

A demonstration script is included to show the capabilities of the progress logger:

```bash
npm run demo:logger
```

The demo simulates downloading and uploading images for several artists, demonstrating:

- Multiple concurrent progress bars
- Different message types
- Progress updates with status messages
- Error handling

## Best Practices

1. **Always use the progress logger** instead of `console.log` for consistency

2. **Include worker context** in all log messages for multi-worker environments:
   ```typescript
   logger.info('Message', undefined, undefined, workerContext);
   ```

3. **Use standardized progress bar IDs** for consistent tracking:
   - `scroll-${username}` - For scrolling operations
   - `download-${username}` - For downloading operations
   - `upload-${username}-batch${n}` - For upload operations

4. **Use appropriate message types**:
   - `info()` for general information
   - `success()` for successful operations
   - `warn()` for non-critical issues
   - `error()` for failures and errors
   - `section()` for new logical sections in the process

5. **Use progress bars for long-running operations** that process multiple items

6. **Enable separate log files** for easier analysis:
   - Concise logs for high-level overview and progress tracking
   - Verbose logs for debugging and detailed operation analysis

## Architecture Details

The advanced logging system consists of the following components:

1. **ProgressLogger**: Central logging class with progress bar and log message management
2. **Logger**: Low-level file logging system
3. **ConsoleMutex**: Thread-safe console output management
4. **ConfigManager**: Configuration loading and management

### Key Interfaces

```typescript
// Worker context for logs and progress bars
interface WorkerContext {
    workerId?: number;
    username?: string;
}

// Log entry for buffered display
interface LogEntry {
    timestamp: Date;
    level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
    message: string;
    workerContext?: WorkerContext;
}

// Progress bars grouped by worker
interface WorkerProgressBars {
    workerId: number;
    username?: string;
    bars: {
        scrolling?: cliProgress.SingleBar;
        downloading?: cliProgress.SingleBar;
        uploading?: Map<string, cliProgress.SingleBar>;
    };
}

// Advanced configuration options
interface AdvancedProgressConfig extends ProgressConfig {
    bufferSize: number;
    refreshInterval: number;
    enableGroupedBars: boolean;
}
```

### Implementation Details

The implementation uses a display refresh timer that updates at controlled intervals:

```typescript
private setupDisplayRefresh(): void {
    // Clear any existing timer
    if (this.displayTimer) {
        clearInterval(this.displayTimer);
    }
    
    // Set up a new timer
    this.displayTimer = setInterval(() => {
        const now = Date.now();
        if (now - this.lastUIUpdateTime >= this.config.refreshInterval!) {
            this.updateDisplay();
            this.lastUIUpdateTime = now;
        }
    }, this.config.refreshInterval);
}
```

The log buffer is implemented as a fixed-size array with FIFO behavior:

```typescript
private addToLogBuffer(level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR', message: string, workerContext?: WorkerContext): void {
    // Create a new log entry
    const entry: LogEntry = {
        timestamp: new Date(),
        level,
        message,
        workerContext
    };
    
    // Add to the buffer
    this.logBuffer.push(entry);
    
    // Keep buffer size within limits
    if (this.logBuffer.length > this.config.bufferSize!) {
        this.logBuffer.shift(); // Remove oldest entry
    }
}
```

### Memory Management

Progress bars for completed workers are cleaned up to save resources:

```typescript
public async cleanupWorkerBars(workerId: number): Promise<void> {
    const workerBars = this.workerBars.get(workerId);
    
    if (workerBars) {
        // Clean up bar references
        workerBars.bars.scrolling = undefined;
        workerBars.bars.downloading = undefined;
        workerBars.bars.uploading.clear();
        
        // Remove the worker entry
        this.workerBars.delete(workerId);
    }
}
```

## Performance Considerations

- **Minimal Updates**: The buffered logging system updates at a controlled interval to reduce CPU usage
- **Cleanup Process**: Progress bars for completed workers are removed to save memory
- **Thread Safety**: All console operations are synchronized through a mutex to prevent corruption
- **Graceful Degradation**: Falls back to simpler output if advanced features are disabled
