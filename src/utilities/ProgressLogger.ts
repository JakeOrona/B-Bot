/**
 * ProgressLogger: Enhanced logger with progress bar support
 * Provides both concise (progress bars) and verbose (detailed logs) modes
 */

import * as cliProgress from 'cli-progress';
import colors from 'colors';
import { Logger } from './Logger';
import { ScraperErrorType } from '../interfaces/ScraperTypes';
import { ConsoleMutex } from './ConsoleMutex';
import fs from 'fs';
import path from 'path';

export interface ProgressConfig {
    logMode: 'concise' | 'verbose';
    showProgressBars: boolean;
    logToFile: boolean;
}

export class ProgressLogger {
    private static instance: ProgressLogger;
    private fileLogger: Logger;
    private config: ProgressConfig;
    private progressBars: Map<string, cliProgress.SingleBar> = new Map();
    private multiBar?: cliProgress.MultiBar;
    private consoleMutex: ConsoleMutex;
    
    /**
     * Private constructor to enforce singleton pattern
     * @param config Progress logger configuration
     */
    private constructor(config: ProgressConfig) {
        this.config = config;
        this.fileLogger = Logger.getInstance();
        this.consoleMutex = ConsoleMutex.getInstance();
        
        if (this.config.showProgressBars && this.config.logMode === 'concise') {
            this.multiBar = new cliProgress.MultiBar({
                clearOnComplete: false,
                hideCursor: true,
                format: ' {bar} | {artistName} | {value}/{total} {type} | {percentage}% | ETA: {eta}s',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
            }, cliProgress.Presets.shades_classic);
        }
    }
    
    /**
     * Get the singleton instance of ProgressLogger
     * @param config Logger configuration (required on first call)
     * @returns ProgressLogger instance
     */
    public static getInstance(config?: ProgressConfig): ProgressLogger {
        if (!ProgressLogger.instance && config) {
            ProgressLogger.instance = new ProgressLogger(config);
        } else if (!ProgressLogger.instance && !config) {
            throw new Error('ProgressLogger must be initialized with config on first call');
        }
        return ProgressLogger.instance;
    }
    
    /**
     * Create a progress bar
     * @param id Unique identifier for the progress bar
     * @param total Total number of items to process
     * @param type Type of operation ('Downloading' or 'Uploading')
     * @param artistName Twitter username being processed
     */
    public async createProgressBar(
        id: string, 
        total: number, 
        type: 'Downloading' | 'Uploading',
        artistName: string
    ): Promise<void> {
        if (this.config.logMode === 'verbose' || !this.config.showProgressBars || !this.multiBar) {
            return;
        }
        
        await this.consoleMutex.execute(async () => {
            const format = type === 'Downloading' 
                ? colors.cyan('{bar}') + ' | {artistName} | {value}/{total} images | {percentage}% | {eta_formatted}'
                : colors.green('{bar}') + ' | {artistName} | {value}/{total} uploaded | {percentage}% | {eta_formatted}';
            
            const icon = type === 'Downloading' ? 'DL: ' : 'UL: ';
            
            if (this.multiBar) {
                const progressBar = this.multiBar.create(total, 0, {
                    type: type,
                    artistName: `${icon}${artistName}`.padEnd(20, ' '), // Fixed width for alignment
                    eta_formatted: '0s'
                }, {
                    format
                });
                
                this.progressBars.set(id, progressBar);
            }
        });
    }
    
    /**
     * Update a progress bar
     * @param id Progress bar identifier
     * @param current Current progress value
     * @param status Optional status message
     */
    public async updateProgress(id: string, current: number, status?: string): Promise<void> {
        await this.consoleMutex.execute(async () => {
            const bar = this.progressBars.get(id);
            if (bar) {
                const payload: any = {};
                if (status) {
                    payload.status = status;
                }
                
                bar.update(current, payload);
            }
        });
    }
    
    /**
     * Mark a progress bar as complete
     * @param id Progress bar identifier
     * @param successMessage Success message to display
     */
    public async completeProgress(id: string, successMessage: string): Promise<void> {
        await this.consoleMutex.execute(async () => {
            const bar = this.progressBars.get(id);
            if (bar) {
                // Complete the bar
                bar.update(bar.getTotal());
                
                // Show completion message in concise mode
                if (this.config.logMode === 'concise') {
                    // Need to use multiBar.log to not disrupt other bars
                    if (this.multiBar) {
                        this.multiBar.log(colors.green('[SUCCESS] ' + successMessage));
                    } else {
                        console.log(colors.green('[SUCCESS] ' + successMessage));
                    }
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
     */
    public async info(message: string, progressId?: string, current?: number): Promise<void> {
        // Always log to file if enabled
        if (this.config.logToFile) {
            this.fileLogger.info(message);
        }
        
        // Use mutex to synchronize console output
        await this.consoleMutex.execute(async () => {
            // Handle console output based on mode
            if (this.config.logMode === 'verbose') {
                console.log(colors.blue('[INFO] ') + message);
            } else if (progressId && current !== undefined) {
                this.updateProgress(progressId, current, message);
            } else if (this.config.logMode === 'concise' && this.multiBar) {
                // For non-progress messages in concise mode, use multiBar.log
                this.multiBar.log(colors.blue('[INFO] ') + message);
            }
        });
    }
    
    /**
     * Log success message
     * @param message Success message
     * @param progressId Optional progress bar ID to complete
     */
    public async success(message: string, progressId?: string): Promise<void> {
        if (this.config.logToFile) {
            this.fileLogger.success(message);
        }
        
        // Use mutex to synchronize console output
        await this.consoleMutex.execute(async () => {
            if (this.config.logMode === 'verbose') {
                console.log(colors.green('[SUCCESS] ') + message);
            } else if (progressId) {
                this.completeProgress(progressId, message);
            } else if (this.config.logMode === 'concise' && this.multiBar) {
                this.multiBar.log(colors.green('[SUCCESS] ' + message));
            } else {
                console.log(colors.green('[SUCCESS] ' + message));
            }
        });
    }
    
    /**
     * Log error message
     * @param message Error message
     * @param error Optional Error object
     * @param errorType Optional error type
     */
    public async error(message: string, error?: Error, errorType?: ScraperErrorType): Promise<void> {
        if (this.config.logToFile) {
            this.fileLogger.error(message, error, errorType);
        }
        
        // Use mutex to synchronize console output
        await this.consoleMutex.execute(async () => {
            // Always show errors regardless of mode
            const errorPrefix = colors.red('[ERROR] ');
            if (this.config.logMode === 'concise' && this.multiBar) {
                this.multiBar.log(errorPrefix + message);
                if (error && error.message) {
                    this.multiBar.log(colors.red('  ' + error.message));
                }
            } else {
                console.log(errorPrefix + message);
                if (error && error.message && (this.config.logMode === 'verbose' || !this.multiBar)) {
                    console.log(colors.red('  ' + error.message));
                }
            }
        });
    }
    
    /**
     * Log warning message
     * @param message Warning message
     */
    public async warn(message: string): Promise<void> {
        if (this.config.logToFile) {
            this.fileLogger.warn(message);
        }
        
        // Use mutex to synchronize console output
        await this.consoleMutex.execute(async () => {
            const warnPrefix = colors.yellow('[WARN] ');
            if (this.config.logMode === 'verbose') {
                console.log(colors.yellow('[WARN] ') + message);
            } else if (this.config.logMode === 'concise' && this.multiBar) {
                this.multiBar.log(warnPrefix + message);
            } else {
                console.log(warnPrefix + message);
            }
        });
    }
    
    /**
     * Log a section header (for visual organization)
     * @param title Section title
     */
    public async section(title: string): Promise<void> {
        if (this.config.logToFile) {
            this.fileLogger.info(`=== ${title} ===`);
        }
        
        // Use mutex to synchronize console output
        await this.consoleMutex.execute(async () => {
            const formattedTitle = colors.cyan(`\n=== ${title.toUpperCase()} ===`);
            if (this.config.logMode === 'concise' && this.multiBar) {
                this.multiBar.log(formattedTitle);
            } else {
                console.log(formattedTitle);
            }
        });
    }
}
