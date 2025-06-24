/**
 * ProfileQueue: A queue for managing artist profiles to be processed concurrently
 */

import { ConcurrentProfileEvent, ProfileQueueItem, ProfileStatus } from '../interfaces/ConcurrentTypes';
import { Logger } from './Logger';
import { EventEmitter } from 'events';

export class ProfileQueue extends EventEmitter {
  private queue: ProfileQueueItem[] = [];
  private maxSize: number;
  private logger: Logger;

  /**
   * Constructor
   * @param maxSize Maximum queue size (optional)
   */
  constructor(maxSize: number = 1000) {
    super();
    this.maxSize = maxSize;
    this.logger = Logger.getInstance();
  }

  /**
   * Add profiles to the queue
   * @param usernames Array of Twitter usernames to add
   * @returns Number of profiles added
   */
  public addProfiles(usernames: string[]): number {
    let addedCount = 0;
    
    for (const username of usernames) {
      if (this.queue.length >= this.maxSize) {
        this.logger.warn(`Queue is full (max size: ${this.maxSize}), stopping additions`);
        break;
      }

      if (!this.isProfileInQueue(username)) {
        this.queue.push({
          username,
          status: ProfileStatus.WAITING
        });
        addedCount++;
      } else {
        this.logger.warn(`Profile @${username} is already in the queue, skipping`);
      }
    }
    
    this.logger.info(`Added ${addedCount} profiles to the queue`);
    return addedCount;
  }

  /**
   * Check if a profile is already in the queue
   * @param username Twitter username
   * @returns True if the profile is in the queue
   */
  private isProfileInQueue(username: string): boolean {
    return this.queue.some(item => item.username === username);
  }

  /**
   * Get the next waiting profile from the queue and atomically mark it as EXTRACTING
   * This prevents race conditions where multiple workers claim the same profile
   * @returns The next profile or undefined if no profiles are waiting
   */
  public getNextWaitingProfile(): ProfileQueueItem | undefined {
    // Use atomic find-and-update pattern to prevent race condition
    const index = this.queue.findIndex(item => item.status === ProfileStatus.WAITING);
    
    if (index === -1) {
      return undefined; // No waiting profiles
    }
    
    // Immediately mark as EXTRACTING to prevent other workers from claiming it
    const profile = this.queue[index];
    
    // Update the profile status in place
    this.queue[index] = {
      ...profile,
      status: ProfileStatus.EXTRACTING,
      startTime: Date.now()
    };
    
    // Log the atomic claim operation
    this.logger.info(`Profile @${profile.username} atomically claimed and marked as EXTRACTING`);
    
    // Emit event for status change
    this.emit(ConcurrentProfileEvent.PROFILE_CLAIMED, this.queue[index]);
    
    // Return a copy of the updated item
    return { ...this.queue[index] };
  }

  /**
   * Update the status of a profile in the queue
   * @param username Twitter username
   * @param status New profile status
   * @param data Optional data to update (images, error, etc.)
   * @returns Updated profile item
   */
  public updateProfileStatus(
    username: string, 
    status: ProfileStatus, 
    data: Partial<Omit<ProfileQueueItem, 'username' | 'status'>> = {}
  ): ProfileQueueItem | undefined {
    const index = this.queue.findIndex(item => item.username === username);
    
    if (index === -1) {
      this.logger.warn(`Profile @${username} not found in queue`);
      return undefined;
    }
    
    const updatedItem: ProfileQueueItem = {
      ...this.queue[index],
      status,
      ...data
    };
    
    // Update timestamps based on status
    if (status === ProfileStatus.EXTRACTING && !updatedItem.startTime) {
      updatedItem.startTime = Date.now();
    } else if (status === ProfileStatus.DOWNLOADING && !updatedItem.extractionEndTime) {
      updatedItem.extractionEndTime = Date.now();
    } else if ([ProfileStatus.COMPLETED, ProfileStatus.FAILED].includes(status) && !updatedItem.completionTime) {
      updatedItem.completionTime = Date.now();
    }
    
    this.queue[index] = updatedItem;
    
    // Emit events based on status changes
    if (status === ProfileStatus.DOWNLOADING) {
      this.emit(ConcurrentProfileEvent.EXTRACTION_COMPLETE, updatedItem);
    } else if (status === ProfileStatus.COMPLETED) {
      this.emit(ConcurrentProfileEvent.PROFILE_COMPLETE, updatedItem);
    } else if (status === ProfileStatus.FAILED) {
      this.emit(ConcurrentProfileEvent.PROFILE_FAILED, updatedItem);
    }
    
    this.logger.info(`Updated profile @${username} status to ${status}`);
    return updatedItem;
  }

  /**
   * Get all profiles in the queue
   * @returns Array of all profile items
   */
  public getAllProfiles(): ProfileQueueItem[] {
    return [...this.queue];
  }

  /**
   * Get queue statistics
   * @returns Object with queue statistics
   */
  public getStats(): { total: number, waiting: number, extracting: number, downloading: number, completed: number, failed: number } {
    return {
      total: this.queue.length,
      waiting: this.queue.filter(item => item.status === ProfileStatus.WAITING).length,
      extracting: this.queue.filter(item => item.status === ProfileStatus.EXTRACTING).length,
      downloading: this.queue.filter(item => item.status === ProfileStatus.DOWNLOADING).length,
      completed: this.queue.filter(item => item.status === ProfileStatus.COMPLETED).length,
      failed: this.queue.filter(item => item.status === ProfileStatus.FAILED).length
    };
  }

  /**
   * Check if all profiles are completed or failed
   * @returns True if all profiles are completed or failed
   */
  public isAllDone(): boolean {
    return this.queue.every(item => 
      item.status === ProfileStatus.COMPLETED || 
      item.status === ProfileStatus.FAILED
    );
  }

  /**
   * Clear the queue
   */
  public clear(): void {
    this.queue = [];
    this.logger.info('Queue cleared');
  }
}
