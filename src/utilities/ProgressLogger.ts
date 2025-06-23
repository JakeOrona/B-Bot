/**
 * ProgressLogger: Enhanced logger with progress bar support
 * Provides both concise (progress bars) and verbose (detailed logs) modes
 * with support for worker identification and dual-file logging
 */

import * as cliProgress from 'cli-progress';
import colors from 'colors';
import { Logger } from './Logger';
import { ScraperErrorType } from '../interfaces/ScraperTypes';
import { ConsoleMutex } from './ConsoleMutex';
import fs from 'fs';
import path from 'path';

export interface WorkerContext {
    workerId?: number;
    username?: string;
}

export interface LogEntry {
    timestamp: Date;
    level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
    message: string;
    workerContext?: WorkerContext;
}

export interface WorkerProgressBars {
    workerId: number;
    username?: string;
    bars: {
        scrolling?: cliProgress.SingleBar;
        downloading?: cliProgress.SingleBar;
        uploading?: Map<string, cliProgress.SingleBar>; // Map of batch ID to progress bar
    };
}

export interface ProgressConfig {
    logMode: 'concise' | 'verbose';
    showProgressBars: boolean;
    logToFile: boolean;
    separateLogFiles?: boolean; // Whether to use separate files for concise and verbose logs
}

export interface AdvancedProgressConfig extends ProgressConfig {
    bufferSize: number; // Number of log entries to buffer for display
    refreshInterval: number; // Refresh interval in ms for updating the display
    enableGroupedBars: boolean; // Whether to display progress bars grouped by worker
}

export class ProgressLogger {
    private static instance: ProgressLogger;
    private fileLogger: Logger;
    private conciseFileLogger?: Logger;
    private config: ProgressConfig & Partial<AdvancedProgressConfig>;
    private progressBars: Map<string, cliProgress.SingleBar> = new Map();
    private workerBars: Map<number, WorkerProgressBars> = new Map();
    private logBuffer: LogEntry[] = [];
    private multiBar?: cliProgress.MultiBar;
    private consoleMutex: ConsoleMutex;
    private displayTimer?: NodeJS.Timeout;
    private lastUIUpdateTime: number = 0;
    private isUpdatingDisplay: boolean = false;
    private displayedSections: Set<string> = new Set();
    private logFilePath: {
        verbose: string;
        concise: string;
    };
    
    /**
     * Private constructor to enforce singleton pattern
     * @param config Progress logger configuration
     */
    private constructor(config: ProgressConfig & Partial<AdvancedProgressConfig>) {
        // Set default values for advanced config
        this.config = {
            ...config,
            bufferSize: config.bufferSize || 8,
            refreshInterval: config.refreshInterval || 100,
            enableGroupedBars: config.enableGroupedBars !== undefined ? config.enableGroupedBars : true
        };
        
        this.fileLogger = Logger.getInstance();
        this.consoleMutex = ConsoleMutex.getInstance();
        
        // Set up dual file logging if enabled
        this.logFilePath = {
            verbose: this.fileLogger.getLogFilePath(),
            concise: ''
        };
        
        // Create separate concise log file if configured
        if (this.config.logToFile && this.config.separateLogFiles) {
            // Create a timestamped concise log file with same timestamp as verbose
            const baseLogPath = this.logFilePath.verbose;
            this.logFilePath.concise = baseLogPath.replace('.log', '-concise.log');
            
            // Initialize the concise logger
            this.conciseFileLogger = Logger.createAdditionalLogger(this.logFilePath.concise);
            
            // Write header to concise log file
            this.conciseFileLogger.info('=== TWITTER/X IMAGE SCRAPER CONCISE LOG ===');
            this.conciseFileLogger.info(`Started: ${new Date().toLocaleString()}`);
            this.conciseFileLogger.info('============================================\n');
        }
        
        if (this.config.showProgressBars && this.config.logMode === 'concise') {
            this.multiBar = new cliProgress.MultiBar({
                clearOnComplete: false,
                hideCursor: true,
                format: '[{workerPrefix}{taskType}] {bar} {value}/{total} {percentage}% ETA: {eta}s',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                noTTYOutput: false,
                emptyOnZero: true
            }, cliProgress.Presets.shades_classic);
            
            // Initialize the display refresh timer if using advanced features
            if (this.config.enableGroupedBars) {
                this.setupDisplayRefresh();
                
                // Display initial header
                this.displayHeader();
            }
        }
    }
    
    /**
     * Get the singleton instance of ProgressLogger
     * @param config Logger configuration (required on first call)
     * @returns ProgressLogger instance
     */
    public static getInstance(config?: ProgressConfig & Partial<AdvancedProgressConfig>): ProgressLogger {
        if (!ProgressLogger.instance && config) {
            ProgressLogger.instance = new ProgressLogger(config);
        } else if (!ProgressLogger.instance && !config) {
            throw new Error('ProgressLogger must be initialized with config on first call');
        }
        return ProgressLogger.instance;
    }
    
    /**
     * Set up the display refresh timer for updating the console UI
     */
    private setupDisplayRefresh(): void {
        // Clear any existing timer
        if (this.displayTimer) {
            clearInterval(this.displayTimer);
            this.displayTimer = undefined;
        }
        
        // Use a significantly longer refresh interval to reduce display corruption
        // 500ms is minimum to prevent visual flicker and overlap issues
        const refreshRate = Math.max(500, this.config.refreshInterval || 500);
        
        // Set up a new timer to refresh the display periodically
        this.displayTimer = setInterval(() => {
            const now = Date.now();
            
            // Only update if sufficient time has passed AND not currently updating
            // This prevents overlapping update calls that corrupt the display
            if (!this.isUpdatingDisplay && 
                now - this.lastUIUpdateTime >= refreshRate) {
                // Schedule the update without awaiting to avoid timer delays
                // Use a debounced approach to prevent rapid successive updates
                this.isUpdatingDisplay = true; // Set flag immediately to block other refreshes
                this.updateDisplay()
                    .catch(err => {
                        console.error('Error updating display:', err);
                    })
                    .finally(() => {
                        // Only clear the updating flag here, not in updateDisplay
                        // This ensures the flag remains set during the entire update cycle
                        setTimeout(() => {
                            this.isUpdatingDisplay = false;
                        }, 100); // Small delay to prevent immediate re-triggering
                    });
            }
        }, refreshRate);
        
        // Set up cleanup on process exit
        process.on('exit', () => {
            if (this.displayTimer) {
                clearInterval(this.displayTimer);
                this.displayTimer = undefined;
            }
            if (this.multiBar) {
                this.multiBar.stop();
            }
        });
        
        // Handle Ctrl+C and other termination signals
        process.on('SIGINT', () => {
            if (this.displayTimer) {
                clearInterval(this.displayTimer);
                this.displayTimer = undefined;
            }
            if (this.multiBar) {
                this.multiBar.stop();
            }
            process.exit(0);
        });
    }
    
    /**
     * Display the header section for the logger UI
     */
    private async displayHeader(): Promise<void> {
        if (!this.multiBar) return;
        
        // Use mutex to prevent display corruption
        await this.consoleMutex.execute(async () => {
            const timestamp = new Date().toISOString();
            const workerCount = this.workerBars.size;
            
            // Use direct console.log instead of multiBar.log to prevent corruption
            console.log(colors.cyan('\n=== Twitter/X Image Scraper Advanced Logging ==='));
            console.log(colors.cyan(`[${timestamp}] Mode: ${this.config.logMode} | Progress bars: ${this.config.showProgressBars ? 'enabled' : 'disabled'} | Workers: ${workerCount}`));
            console.log(colors.cyan(''));
        });
    }
    
    /**
     * Update the console display with current progress and log buffer
     */
    private async updateDisplay(): Promise<void> {
        // Skip if we don't have proper configuration
        if (!this.multiBar || !this.config.enableGroupedBars) return;
        
        // Use mutex to ensure only one update happens at a time
        return this.consoleMutex.execute(async () => {
            try {
                // Flag is now set in setupDisplayRefresh before this method is called
                // This prevents concurrent display updates that cause corruption
                
                // Consider if we need a complete display reset due to corruption
                if (this.needsDisplayReset()) {
                    await this.resetDisplay();
                    return;
                }
                
                // Track which sections we're displaying in this update
                const currentSections = new Set<string>();
                
                // ===== CLEAR SCREEN SECTION =====
                
                // Use a minimal clearing approach that doesn't interfere with progress bars
                // Instead of clearing the whole screen, we'll insert blank lines and 
                // carefully track which sections are displayed
                
                // Insert a divider to visually separate updates
                console.log('\n'); // Simple blank line as a visual separator
                
                // ===== HEADER SECTION =====
                
                // Display header (only if not already displayed recently or forced refresh)
                const headerKey = 'header';
                const timestamp = new Date().toISOString();
                const workerCount = this.workerBars.size;
                
                // Always show the header on every refresh for clarity
                console.log(colors.cyan('=== Twitter/X Image Scraper Advanced Logging ==='));
                console.log(colors.cyan(`[${timestamp}] Mode: ${this.config.logMode} | Progress bars: ${this.config.showProgressBars ? 'enabled' : 'disabled'} | Workers: ${workerCount}`));
                console.log(''); // Empty line after header
                
                // Add to tracking
                this.displayedSections.add(headerKey);
                currentSections.add(headerKey);
                
                // ===== WORKER PROGRESS SECTION =====
                
                // Display worker progress section header (only if we have workers)
                if (this.workerBars.size > 0) {
                    const progressKey = 'worker-progress';
                    
                    console.log(colors.cyan('=== Worker Progress ==='));
                    
                    // Progress bars are handled by the multiBar component,
                    // we just need to ensure the section header is displayed
                    
                    // Add to tracking
                    this.displayedSections.add(progressKey);
                    currentSections.add(progressKey);
                    
                    // Add spacing after the progress section header
                    console.log('');
                }
                
                // ===== RECENT LOGS SECTION =====
                
                // Display recent logs section if we have logs
                if (this.logBuffer.length > 0) {
                    const logsKey = 'recent-logs';
                    
                    // Always show the logs header
                    console.log(colors.cyan('=== Recent Logs ==='));
                    
                    // Add to tracking
                    this.displayedSections.add(logsKey);
                    currentSections.add(logsKey);
                    
                    // Display log entries directly with console.log
                    // This is safer than using multiBar.log which can corrupt the display
                    for (const entry of this.logBuffer) {
                        let logColor;
                        let prefix;
                        
                        switch (entry.level) {
                            case 'INFO':
                                logColor = colors.blue;
                                prefix = '[INFO]';
                                break;
                            case 'SUCCESS':
                                logColor = colors.green;
                                prefix = '[SUCCESS]';
                                break;
                            case 'WARN':
                                logColor = colors.yellow;
                                prefix = '[WARN]';
                                break;
                            case 'ERROR':
                                logColor = colors.red;
                                prefix = '[ERROR]';
                                break;
                        }
                        
                        const time = entry.timestamp.toLocaleTimeString();
                        const workerPrefix = this.formatWorkerContext(entry.workerContext);
                        
                        // Use console.log with message deduplication
                        const logMessage = `[${time}] ${logColor(prefix)} ${workerPrefix}${entry.message}`;
                        console.log(logMessage);
                    }
                    
                    // Add a trailing blank line after logs
                    console.log('');
                }
                
                // Clean up sections that are no longer displayed in this update
                // But maintain header information to avoid reprinting headers too often
                for (const section of this.displayedSections) {
                    if (!currentSections.has(section) && 
                        !section.startsWith('section-') && // Keep custom sections
                        section !== 'header') {            // Keep header
                        this.displayedSections.delete(section);
                    }
                }
                
                // Update timestamp of last display refresh
                this.lastUIUpdateTime = Date.now();
                
            } catch (error) {
                // If we hit an error during display refresh, log it and trigger a display reset
                console.error('Error refreshing display:', error);
                
                // Reset the display on error to recover
                await this.resetDisplay();
            }
            
            // Important: the isUpdatingDisplay flag is managed by the calling function
            // to ensure proper debouncing between updates
        });
    }
    
  /**
   * Create a progress bar
   * @param id Unique identifier for the progress bar
   * @param total Total number of items to process
   * @param type Type of operation ('Downloading', 'Uploading', or 'Scrolling')
   * @param artistName Twitter username being processed
   * @param workerContext Optional worker context information
     */
    public async createProgressBar(
        id: string, 
        total: number, 
        type: 'Downloading' | 'Uploading' | 'Scrolling',
        artistName: string,
        workerContext?: WorkerContext
    ): Promise<void> {
        if (this.config.logMode === 'verbose' || !this.config.showProgressBars || !this.multiBar) {
            return;
        }
        
        // If we have worker context and advanced features, use the grouped bars system
        if (workerContext?.workerId !== undefined && 
            workerContext?.username && 
            this.config.enableGroupedBars) {
            
            // Extract batch ID from progress ID if it's an upload (format: upload-username-batchX)
            let batchId: string | undefined;
            if (type === 'Uploading' && id.startsWith('upload-') && id.split('-').length > 2) {
                batchId = id.split('-').slice(2).join('-');
            }
            
            // Use the new worker-based API
            await this.createWorkerProgressBar(
                workerContext.workerId,
                workerContext.username,
                type,
                id,
                total,
                batchId
            );
            
            return;
        }
        
        // Fall back to legacy method if not using worker grouping
        await this.consoleMutex.execute(async () => {
            // Format based on operation type
            let colorBar = colors.cyan('{bar}'); // Default (download)
            let suffix = 'images';
            
            if (type === 'Uploading') {
                colorBar = colors.green('{bar}');
                suffix = 'uploaded';
            } else if (type === 'Scrolling') {
                colorBar = colors.yellow('{bar}');
                suffix = 'scrolls';
            }
            
            const format = `${colorBar} | {workerPrefix}{artistName} | {value}/{total} ${suffix} | {percentage}% | ETA: {eta}s`;
            
            // Create worker prefix
            const workerPrefix = this.formatWorkerContext(workerContext);
            
            if (this.multiBar) {
                const progressBar = this.multiBar.create(total, 0, {
                    type: type,
                    artistName: artistName,
                    workerPrefix: workerPrefix,
                    taskType: type,
                    eta: '0'
                }, {
                    format
                });
                
                this.progressBars.set(id, progressBar);
                
                // If we have separate log files, log the creation of this progress bar to the concise log
                if (this.config.logToFile && this.config.separateLogFiles && this.conciseFileLogger) {
                    const progressInfo = `${workerPrefix}${type} ${artistName} (0/${total}, 0%) started`;
                    this.conciseFileLogger.info(progressInfo);
                }
            }
        });
    }
    
  /**
   * Update a progress bar
   * @param id Progress bar identifier
   * @param current Current progress value
   * @param status Optional status message
   * @param workerContext Optional worker context information
   */
  public async updateProgress(id: string, current: number, status?: string, workerContext?: WorkerContext): Promise<void> {
    await this.consoleMutex.execute(async () => {
        const bar = this.progressBars.get(id);
        if (bar) {
            const payload: any = {};
            if (status) {
                payload.status = status;
            }
            
            bar.update(current, payload);
            
            // If we have separate log files, log this update to the concise log
            if (this.config.logToFile && this.config.separateLogFiles && this.conciseFileLogger && current % 5 === 0) {
                // Create worker prefix for log
                let workerPrefix = '';
                if (workerContext && (workerContext.workerId !== undefined || workerContext.username)) {
                    workerPrefix = `[Worker${workerContext.workerId !== undefined ? '#' + workerContext.workerId : ''}${workerContext.username ? ':@' + workerContext.username : ''}] `;
                }
                
                const progressInfo = `${workerPrefix}Progress ${id}: ${current}/${bar.getTotal()} (${Math.round(current / bar.getTotal() * 100)}%)`;
                this.conciseFileLogger.info(progressInfo);
            }
        }
    });
    }
    
  /**
   * Mark a progress bar as complete
   * @param id Progress bar identifier
   * @param successMessage Success message to display
   * @param workerContext Optional worker context information
   */
  public async completeProgress(id: string, successMessage: string, workerContext?: WorkerContext): Promise<void> {
    await this.consoleMutex.execute(async () => {
        const bar = this.progressBars.get(id);
        if (bar) {
            // Complete the bar
            bar.update(bar.getTotal());
            
            // Create worker prefix for log
            let workerPrefix = '';
            if (workerContext && (workerContext.workerId !== undefined || workerContext.username)) {
                workerPrefix = `[Worker${workerContext.workerId !== undefined ? '#' + workerContext.workerId : ''}${workerContext.username ? ':@' + workerContext.username : ''}] `;
            }
            
            // Show completion message in concise mode
            if (this.config.logMode === 'concise') {
                const formattedMessage = `${workerPrefix}${successMessage}`;
                
                // Use direct console.log instead of multiBar.log to prevent display corruption
                console.log(colors.green('[SUCCESS] ' + formattedMessage));
            }
            
            // Log completion to concise log file if enabled
            if (this.config.logToFile && this.config.separateLogFiles && this.conciseFileLogger) {
                const completionInfo = `${workerPrefix}[SUCCESS] Completed ${id}: ${successMessage}`;
                this.conciseFileLogger.success(completionInfo);
            }
            
            // Remove from our tracking map
            this.progressBars.delete(id);
        }
    });
    }
    
    /**
     * Stop all progress bars and clean up
     */
    public async stopAll(): Promise<void> {
        await this.consoleMutex.execute(async () => {
            if (this.multiBar) {
                this.multiBar.stop();
            }
        });
    }
    
  /**
   * Log informational message
   * @param message Log message
   * @param progressId Optional progress bar ID to update
   * @param current Optional current progress value
   * @param workerContext Optional worker context information
   */
  public async info(message: string, progressId?: string, current?: number, workerContext?: WorkerContext): Promise<void> {
    // Format the message with worker context
    const formattedMessage = `${this.formatWorkerContext(workerContext)}${message}`;
    
    // Always log to file if enabled - file logging is unchanged
    if (this.config.logToFile) {
        this.fileLogger.info(formattedMessage);
        
        // If this is a concise-appropriate message & separate files are enabled, log to concise file too
        if (this.config.separateLogFiles && this.conciseFileLogger && 
            (progressId || message.includes('Starting') || message.includes('Completed') || message.includes('Found'))) {
            this.conciseFileLogger.info(formattedMessage);
        }
    }
    
    // Add to log buffer if using advanced features
    if (this.config.enableGroupedBars) {
        await this.addToLogBuffer('INFO', message, workerContext);
    }
    
    // Use mutex to synchronize console output
    await this.consoleMutex.execute(async () => {
        // Handle console output based on mode
        if (this.config.logMode === 'verbose') {
            // In verbose mode, always show all logs directly
            console.log(colors.blue('[INFO] ') + formattedMessage);
        } else if (progressId && current !== undefined) {
            // If this is a progress update, use the progress system
            await this.updateProgress(progressId, current, message, workerContext);
        } else if (this.config.logMode === 'concise') {
            // In concise mode, behavior depends on whether we're using grouped bars
            if (this.config.enableGroupedBars) {
                // With grouped bars, we only add to buffer but don't output directly
                // This prevents corrupting the display with overlapping output
                // The buffer will be displayed on the next updateDisplay() cycle
                return;
            } else {
                // Without grouped bars, use direct console.log
                console.log(colors.blue('[INFO] ') + formattedMessage);
            }
        }
    });
    }
    
  /**
   * Log success message
   * @param message Success message
   * @param progressId Optional progress bar ID to complete
   * @param workerContext Optional worker context information
   */
  public async success(message: string, progressId?: string, workerContext?: WorkerContext): Promise<void> {
    // Format the message with worker context
    const formattedMessage = `${this.formatWorkerContext(workerContext)}${message}`;
    
    // Handle file logging first - this is unchanged
    if (this.config.logToFile) {
        this.fileLogger.success(formattedMessage);
        
        // Always log success messages to concise file if enabled
        if (this.config.separateLogFiles && this.conciseFileLogger) {
            this.conciseFileLogger.success(formattedMessage);
        }
    }
    
    // Add to log buffer if using advanced features
    if (this.config.enableGroupedBars) {
        await this.addToLogBuffer('SUCCESS', message, workerContext);
    }
    
    // Use mutex to synchronize console output
    await this.consoleMutex.execute(async () => {
        if (this.config.logMode === 'verbose') {
            // In verbose mode, always use direct console output
            console.log(colors.green('[SUCCESS] ') + formattedMessage);
        } else if (progressId) {
            // If we're completing a progress bar, use the specialized method
            await this.completeProgress(progressId, message, workerContext);
        } else if (this.config.logMode === 'concise') {
            // In concise mode, behavior depends on whether we're using grouped bars
            if (this.config.enableGroupedBars) {
                // With grouped bars, we don't output directly - the buffer handles it
                // This prevents corrupting the display with overlapping output
                return;
            } else {
                // Without grouped bars, use direct console output
                console.log(colors.green('[SUCCESS] ') + formattedMessage);
            }
        }
    });
    }
    
  /**
   * Log error message
   * @param message Error message
   * @param error Optional Error object
   * @param errorType Optional error type
   * @param workerContext Optional worker context information
   */
  public async error(message: string, error?: Error, errorType?: ScraperErrorType, workerContext?: WorkerContext): Promise<void> {
    // Format the message with worker context
    const formattedMessage = `${this.formatWorkerContext(workerContext)}${message}`;
    
    if (this.config.logToFile) {
        this.fileLogger.error(formattedMessage, error, errorType);
        
        // Always log errors to concise file too if enabled
        if (this.config.separateLogFiles && this.conciseFileLogger) {
            this.conciseFileLogger.error(formattedMessage, error, errorType);
        }
    }
    
    // Add to log buffer if using advanced features
    if (this.config.enableGroupedBars) {
        await this.addToLogBuffer('ERROR', message, workerContext);
        
        // If there's an error message, add that too
        if (error && error.message) {
            await this.addToLogBuffer('ERROR', `  ${error.message}`, workerContext);
        }
    }
    
    // Use mutex to synchronize console output
    await this.consoleMutex.execute(async () => {
        // Always show errors regardless of mode
        const errorPrefix = colors.red('[ERROR] ');
        
        // For errors, always use direct console output for critical visibility
        // regardless of the logging mode
        console.log(errorPrefix + formattedMessage);
        
        if (error && error.message) {
            console.log(colors.red(`  ${this.formatWorkerContext(workerContext)}${error.message}`));
        }
    });
    }
    
  /**
   * Log warning message
   * @param message Warning message
   * @param workerContext Optional worker context information
   */
  public async warn(message: string, workerContext?: WorkerContext): Promise<void> {
    // Format the message with worker context
    const formattedMessage = `${this.formatWorkerContext(workerContext)}${message}`;
    
    // File logging is unchanged
    if (this.config.logToFile) {
        this.fileLogger.warn(formattedMessage);
        
        // Log warnings to concise file if enabled
        if (this.config.separateLogFiles && this.conciseFileLogger) {
            this.conciseFileLogger.warn(formattedMessage);
        }
    }
    
    // Add to log buffer if using advanced features
    if (this.config.enableGroupedBars) {
        await this.addToLogBuffer('WARN', message, workerContext);
    }
    
    // Use mutex to synchronize console output
    await this.consoleMutex.execute(async () => {
        const warnPrefix = colors.yellow('[WARN] ');
        
        // Warnings are important enough to always show directly
        // regardless of mode, unless we're in grouped mode where
        // they'll appear in the log buffer
        if (this.config.logMode === 'verbose' || 
            (this.config.logMode === 'concise' && !this.config.enableGroupedBars)) {
            // Use direct console output
            console.log(warnPrefix + formattedMessage);
        } 
        // In concise+grouped mode, the warning will be shown in the buffer display
    });
    }
    
    /**
     * Log a section header (for visual organization)
     * @param title Section title
     * @param workerContext Optional worker context information
     */
    public async section(title: string, workerContext?: WorkerContext): Promise<void> {
        // Format the message with worker context
        const workerPrefix = this.formatWorkerContext(workerContext);
        const formattedSectionTitle = `=== ${title} ===`;
        const logMessage = `${workerPrefix}${formattedSectionTitle}`;
        
        // Generate a unique section key based on title and worker
        const sectionKey = `section-${title}-${workerPrefix}`;
        
        // Handle file logging first - this is unchanged
        if (this.config.logToFile) {
            this.fileLogger.info(logMessage);
            
            // Always log section headers to concise file if enabled
            if (this.config.separateLogFiles && this.conciseFileLogger) {
                this.conciseFileLogger.info(logMessage);
            }
        }
        
        // Add to log buffer if using advanced features 
        if (this.config.enableGroupedBars) {
            await this.addToLogBuffer('INFO', `=== ${title.toUpperCase()} ===`, workerContext);
        }
        
        // Use mutex to synchronize console output
        await this.consoleMutex.execute(async () => {
            // Enhanced deduplication logic:
            // 1. Check if this section was shown recently
            // 2. Add a time component to prevent indefinite suppression
            const isDuplicate = this.displayedSections.has(sectionKey) && 
                              Date.now() - this.lastUIUpdateTime < 5000;
                              
            if (isDuplicate) {
                // If duplicate and recent, skip output
                return;
            }
            
            // Use a newline prefix for cleaner separation
            const formattedTitle = colors.cyan(`\n${workerPrefix}=== ${title.toUpperCase()} ===`);
            
            // Always use direct console.log for sections to prevent corruption
            console.log(formattedTitle);
            
            // Add small spacer after section header
            console.log('');
            
            // Mark this section as displayed with timestamp
            this.displayedSections.add(sectionKey);
        });
    }
    
    /**
     * Format worker context into a string prefix
     * @param workerContext Worker context information
     * @returns Formatted worker prefix string
     */
    private formatWorkerContext(workerContext?: WorkerContext): string {
        if (!workerContext || (workerContext.workerId === undefined && !workerContext.username)) {
            return '';
        }
        
        return `[Worker${workerContext.workerId !== undefined ? '#' + workerContext.workerId : ''}${workerContext.username ? ':@' + workerContext.username : ''}] `;
    }
    
    /**
     * Add a log entry to the buffer
     * @param level Log level
     * @param message Log message
     * @param workerContext Worker context
     */
    private async addToLogBuffer(level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR', message: string, workerContext?: WorkerContext): Promise<void> {
        // Use mutex for thread-safe buffer modification
        await this.consoleMutex.execute(async () => {
            // Create a new log entry
            const entry: LogEntry = {
                timestamp: new Date(),
                level,
                message,
                workerContext
            };
            
            // Enhanced duplicate detection with worker context consideration
            const now = Date.now();
            const workerKey = workerContext?.workerId !== undefined ? 
                `worker-${workerContext.workerId}` : 
                (workerContext?.username ? `user-${workerContext.username}` : 'global');
                
            const isDuplicate = this.logBuffer.some(existing => 
                existing.message === message && 
                existing.level === level && 
                (now - existing.timestamp.getTime() < 3000) && // Longer deduplication window
                (this.formatWorkerContext(existing.workerContext) === this.formatWorkerContext(workerContext))); 
                // Only consider it duplicate if from same worker
            
            // Skip if it's a duplicate message from the same source
            if (isDuplicate) return;
            
            // Add to the buffer
            this.logBuffer.push(entry);
            
            // Keep buffer size within limits, using a larger buffer for better context
            const bufferSize = Math.max(10, this.config.bufferSize || 10);
            while (this.logBuffer.length > bufferSize) {
                this.logBuffer.shift(); // Remove oldest entry
            }
            
            // Don't trigger immediate display refreshes - let the timer handle it
            // This prevents too-frequent display updates that cause corruption
            // The regular refresh timer will pick this up on next cycle
        });
    }
    
    /**
     * Initialize progress bars for a worker
     * @param workerId Worker ID
     * @param username Worker username
     * @returns Worker bars object
     */
    private initializeWorkerBars(workerId: number, username?: string): WorkerProgressBars {
        // Skip if not using grouped bars
        if (!this.config.enableGroupedBars || !this.multiBar) {
            return {
                workerId,
                username,
                bars: {
                    uploading: new Map()
                }
            };
        }
        
        const workerPrefix = `Worker#${workerId}${username ? `:@${username}` : ''}`;
        
        const workerBars: WorkerProgressBars = {
            workerId,
            username,
            bars: {
                uploading: new Map()
            }
        };
        
        // Create a placeholder in workerBars map so we can reference later
        this.workerBars.set(workerId, workerBars);
        
        // Update the display to show the new worker
        this.updateDisplay();
        
        return workerBars;
    }
    
    /**
     * Get worker bars object, creating it if needed
     * @param workerId Worker ID
     * @param username Worker username
     * @returns Worker bars object
     */
    private getWorkerBars(workerId: number, username?: string): WorkerProgressBars {
        // Get existing worker bars or create new ones
        const existingBars = this.workerBars.get(workerId);
        if (existingBars) {
            return existingBars;
        }
        
        return this.initializeWorkerBars(workerId, username);
    }
    
    /**
     * Create a progress bar for a specific worker task
     * @param workerId Worker ID
     * @param username Worker username
     * @param taskType Task type (Scrolling, Downloading, Uploading)
     * @param id Unique bar ID
     * @param total Total items
     * @param batchId Optional batch ID for upload tasks
     * @returns Bar ID 
     */
    public async createWorkerProgressBar(
        workerId: number,
        username: string,
        taskType: 'Scrolling' | 'Downloading' | 'Uploading',
        id: string,
        total: number,
        batchId?: string
    ): Promise<string> {
        if (!this.multiBar || !this.config.showProgressBars || this.config.logMode !== 'concise') {
            return id;
        }
        
        await this.consoleMutex.execute(async () => {
            // Get worker bars
            const workerBars = this.getWorkerBars(workerId, username);
            
            // Format based on operation type
            let barStyle = colors.cyan('{bar}'); // Default (download)
            let suffix = 'images';
            
            if (taskType === 'Uploading') {
                barStyle = colors.green('{bar}');
                suffix = 'uploaded';
            } else if (taskType === 'Scrolling') {
                barStyle = colors.yellow('{bar}');
                suffix = 'scrolls';
            }
            
            // Format string for the bar
            const format = `${barStyle} | {value}/{total} ${suffix} | {percentage}% | ETA: {eta}s`;
            
            // Create worker prefix for display
            const displayPrefix = `[Worker#${workerId}:@${username}] ${taskType}: `;
            
            // Create the progress bar
            const progressBar = this.multiBar!.create(total, 0, {
                workerPrefix: displayPrefix,
                taskType,
                batchId: batchId || '',
                eta: '0'
            }, {
                format
            });
            
            // Store the bar in the appropriate place
            if (taskType === 'Scrolling') {
                workerBars.bars.scrolling = progressBar;
            } else if (taskType === 'Downloading') {
                workerBars.bars.downloading = progressBar;
            } else if (taskType === 'Uploading' && batchId) {
                workerBars.bars.uploading!.set(batchId, progressBar);
            }
            
            // Store in the old map for compatibility
            this.progressBars.set(id, progressBar);
            
            // Update the display
            this.updateDisplay();
            
            // Log to concise file if enabled
            if (this.config.logToFile && this.config.separateLogFiles && this.conciseFileLogger) {
                const progressInfo = `[Worker#${workerId}:@${username}] ${taskType} (0/${total}, 0%) started`;
                this.conciseFileLogger.info(progressInfo);
            }
        });
        
        return id;
    }
    
    /**
     * Remove worker progress bars when they're no longer needed
     * @param workerId Worker ID to clean up
     */
    public async cleanupWorkerBars(workerId: number): Promise<void> {
        await this.consoleMutex.execute(async () => {
            const workerBars = this.workerBars.get(workerId);
            
            if (workerBars) {
                // Clean up scrolling bar if exists
                if (workerBars.bars.scrolling) {
                    // The bar has already been stopped/completed by this point,
                    // so we just need to remove it from our tracking
                    workerBars.bars.scrolling = undefined;
                }
                
                // Clean up downloading bar if exists
                if (workerBars.bars.downloading) {
                    workerBars.bars.downloading = undefined;
                }
                
                // Clean up any upload bars
                if (workerBars.bars.uploading && workerBars.bars.uploading.size > 0) {
                    workerBars.bars.uploading.clear();
                }
                
                // Remove the worker entry if all bars are gone
                if (!workerBars.bars.scrolling && 
                    !workerBars.bars.downloading && 
                    (!workerBars.bars.uploading || workerBars.bars.uploading.size === 0)) {
                    this.workerBars.delete(workerId);
                    
                    // Log cleanup
                    await this.info(`Cleanup: Removed progress tracking for Worker #${workerId}`, undefined, undefined, { workerId });
                }
            }
        });
    }
    
    /**
     * Check if the display appears corrupted and needs a full reset
     * This helps recover from badly corrupted terminal states
     * @returns True if a reset is needed
     */
    private needsDisplayReset(): boolean {
        // If it's been a very long time since last update, do a reset
        const timeSinceUpdate = Date.now() - this.lastUIUpdateTime;
        if (timeSinceUpdate > 15000) {
            return true;
        }
        
        // If we have a lot of displayed sections, that may indicate corruption
        if (this.displayedSections.size > 15) {
            return true;
        }
        
        // If isUpdatingDisplay flag has been stuck for too long, that indicates a problem
        if (this.isUpdatingDisplay && timeSinceUpdate > 5000) {
            return true;
        }
        
        // Check for excess worker bars vs actual workers
        // as a sign of display corruption
        if (this.progressBars.size > this.workerBars.size * 3 + 5) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Reset the display completely to recover from corruption
     */
    private async resetDisplay(): Promise<void> {
        await this.consoleMutex.execute(async () => {
            // Reset the display state tracking
            this.displayedSections.clear();
            this.isUpdatingDisplay = false;
            
            if (this.multiBar) {
                try {
                    // Try to fully clear the terminal (works in most terminals)
                    // This is the most reliable way to fix a corrupted display
                    console.clear();
                    
                    // Add separator to visually indicate a reset occurred
                    console.log(colors.yellow('\n==== DISPLAY RESET ====\n'));
                    
                    // Stop and recreate the multibar to ensure clean state
                    this.multiBar.stop();
                    
                    // Small delay to ensure terminal is ready
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // Recreate the multibar with same settings
                    this.multiBar = new cliProgress.MultiBar({
                        clearOnComplete: false,
                        hideCursor: true,
                        format: '[{workerPrefix}{taskType}] {bar} {value}/{total} {percentage}% ETA: {eta}s',
                        barCompleteChar: '\u2588',
                        barIncompleteChar: '\u2591',
                        noTTYOutput: false,
                        emptyOnZero: true
                    }, cliProgress.Presets.shades_classic);
                    
                    // Recreate all progress bars from our tracking data with correct state
                    for (const [workerId, workerBarData] of this.workerBars.entries()) {
                        const workerPrefix = `Worker#${workerId}${workerBarData.username ? `:@${workerBarData.username}` : ''}`;
                        
                        // Recreate scrolling bar if exists
                        if (workerBarData.bars.scrolling) {
                            const scrollBar = this.multiBar.create(100, 0, {
                                workerPrefix: `${workerPrefix}`,
                                taskType: 'Scrolling',
                                eta: '0'
                            });
                            workerBarData.bars.scrolling = scrollBar;
                        }
                        
                        // Recreate downloading bar if exists
                        if (workerBarData.bars.downloading) {
                            const downloadBar = this.multiBar.create(100, 0, {
                                workerPrefix: `${workerPrefix}`,
                                taskType: 'Downloading',
                                eta: '0'
                            });
                            workerBarData.bars.downloading = downloadBar;
                        }
                        
                        // Recreate upload bars if exist
                        if (workerBarData.bars.uploading) {
                            for (const [batchId, _] of workerBarData.bars.uploading.entries()) {
                                const uploadBar = this.multiBar.create(100, 0, {
                                    workerPrefix: `${workerPrefix}`,
                                    taskType: `Uploading ${batchId}`,
                                    eta: '0'
                                });
                                workerBarData.bars.uploading.set(batchId, uploadBar);
                            }
                        }
                    }
                    
                    // Rebuild the regular progress bars map for backward compatibility
                    this.progressBars = new Map();
                    for (const [workerId, workerBarData] of this.workerBars.entries()) {
                        if (workerBarData.bars.scrolling) {
                            const scrollId = `scroll-${workerBarData.username || workerId}`;
                            this.progressBars.set(scrollId, workerBarData.bars.scrolling);
                        }
                        if (workerBarData.bars.downloading) {
                            const downloadId = `download-${workerBarData.username || workerId}`;
                            this.progressBars.set(downloadId, workerBarData.bars.downloading);
                        }
                    }
                    
                } catch (error) {
                    console.error('Failed to reset display:', error);
                }
                
                // Clear log buffer to prevent duplicate messages
                this.logBuffer = [];
                
                // Redisplay header
                await this.displayHeader();
                
                // Force an immediate update of the display
                this.lastUIUpdateTime = 0; // Force refresh by invalidating last update time
            }
        });
    }
    
    /**
     * Safely log a message to the console without disrupting progress bars
     * @param message Message to log
     * @param color Optional color function to apply
     * @param level Optional log level for buffer entries
     * @param workerContext Optional worker context
     */
    private async safeLog(
        message: string, 
        color?: (text: string) => string, 
        level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' = 'INFO',
        workerContext?: WorkerContext
    ): Promise<void> {
        await this.consoleMutex.execute(async () => {
            const formattedMessage = color ? color(message) : message;
            
            // In concise mode with grouped bars, add to buffer instead of direct output
            if (this.config.logMode === 'concise' && this.config.enableGroupedBars) {
                // Add to buffer without log prefix since that will be added in display
                const messageWithoutPrefix = message.replace(/^\[(INFO|SUCCESS|WARN|ERROR)\]\s*/, '');
                await this.addToLogBuffer(level, messageWithoutPrefix, workerContext);
                return;
            }
            
            // For all other modes, use direct console output
            // This is safer than multiBar.log which can corrupt the display
            console.log(formattedMessage);
        });
    }
}
