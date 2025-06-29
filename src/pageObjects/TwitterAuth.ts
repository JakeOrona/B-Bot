/**
 * TwitterAuth: Page object for Twitter/X authentication
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { BasePage } from './BasePage';
import { AuthCredentials, ScraperError, ScraperErrorType } from '../interfaces/ScraperTypes';
import fs from 'fs';
import path from 'path';

export class TwitterAuth extends BasePage {
  private readonly loginUrl: string = 'https://x.com/login';
  private static readonly storageStatePath: string = path.join(process.cwd(), 'config', 'auth-state.json');

  /**
   * Static helper to create a context with persisted auth state if available
   */
  public static async createContextWithAuthState(browser: Browser, logger: any): Promise<BrowserContext> {
    try {
      if (fs.existsSync(TwitterAuth.storageStatePath)) {
        logger.info('Loading saved authentication state...');
        return await browser.newContext({ storageState: TwitterAuth.storageStatePath });
      } else {
        logger.info('No saved authentication state found. Creating new context.');
        return await browser.newContext();
      }
    } catch (err) {
      logger.error(`Failed to load auth state: ${err}. Falling back to new context.`);
      return await browser.newContext();
    }
  }

  /**
   * Save the current context's storage state
   */
  public static async saveAuthState(context: BrowserContext, logger: any): Promise<void> {
    try {
      await context.storageState({ path: TwitterAuth.storageStatePath });
      logger.info('Authentication state saved successfully.');
    } catch (err) {
      logger.error(`Failed to save authentication state: ${err}`);
    }
  }

  /**
   * Constructor for TwitterAuth
   * @param page Playwright Page instance
   * @param context Playwright BrowserContext instance
   * @param browser Playwright Browser instance
   */
  constructor(page: Page, context: BrowserContext, browser: Browser) {
    super(page, context, browser);
  }
  
  // Locators - Authentication related
  private readonly usernameInput = this.page.getByRole('textbox', { name: 'Phone, email, or username' });
  private readonly nextButton = this.page.getByRole('button', { name: 'Next' });
  private readonly passwordInput = this.page.getByRole('textbox', { name: 'password' });
  private readonly loginButton = this.page.getByTestId('LoginForm_Login_Button');
  private readonly passwordField = this.page.locator('input[name="password"]');
  
  // Verification related locators
  private readonly verificationInput = this.page.getByTestId('ocfEnterTextTextInput');
  private readonly verificationNextButton = this.page.getByTestId('ocfEnterTextNextButton');
  private readonly twoFactorInput = this.page.locator('input[data-testid="LoginForm_CodeInput"]');
  
  // Navigation and profile locators
  private readonly homeTabLink = this.page.getByTestId('AppTabBar_Home_Link');
  private readonly accountMenuButton = this.page.getByTestId('SideNav_AccountSwitcher_Button');
  private readonly logoutButton = this.page.getByTestId('AccountSwitcher_Logout_Button');
  private readonly confirmLogoutButton = this.page.getByTestId('confirmationSheetConfirm');
  
  // Additional login verification locators
  private readonly composeButton = this.page.getByTestId('FloatingActionButton');
  private readonly notificationsTabLink = this.page.getByTestId('AppTabBar_Notifications_Link');
  private readonly exploreTabLink = this.page.getByTestId('AppTabBar_Explore_Link');
  private readonly loginForm = this.page.locator('form[data-testid="LoginForm_Login_Button"]').first();
  private readonly signupButton = this.page.getByTestId('signup');
  private readonly userProfileName = this.page.locator('[data-testid="User-Name"]');

  private readonly usernameInputs = [
    this.page.getByRole('textbox', { name: 'Phone, email, or username' }),
    this.page.locator('input[name="text"]').first(),
    this.page.locator('input[data-testid="ocfEnterTextTextInput"]'),
    this.page.locator('input[autocomplete="username"]'),
    this.page.locator('input[type="text"]').first()
  ];

  private readonly nextButtons = [
    this.page.getByRole('button', { name: 'Next' }),
    this.page.locator('button[role="button"]:has-text("Next")'),
    this.page.locator('[data-testid="LoginForm_Login_Button"]'),
    this.page.locator('button:has-text("Next")')
  ];

  private readonly passwordInputs = [
    this.page.getByRole('textbox', { name: 'password' }),
    this.page.locator('input[name="password"]'),
    this.page.locator('input[type="password"]'),
    this.page.locator('input[autocomplete="current-password"]')
  ];

  private readonly loginButtons = [
    this.page.getByTestId('LoginForm_Login_Button'),
    this.page.locator('button[data-testid="LoginForm_Login_Button"]'),
    this.page.locator('button:has-text("Log in")'),
    this.page.locator('button[type="submit"]')
  ];
  
  /**
   * Login to Twitter with username and password
   * @param credentials Twitter login credentials
   */
  public async login(credentials: AuthCredentials): Promise<void> {
    try {
      // Check if already logged in (validate state)
      if (await this.verifyLoggedIn()) {
        this.logger.success('Already logged in with persisted authentication state.');
        return;
      }
      this.logger.info('Performing full login flow...');
      await this.performFullLogin(credentials);
      // Save storage state after successful login
      await TwitterAuth.saveAuthState(this.context, this.logger);
    } catch (error) {
      this.logger.error('Login failed', error as Error, ScraperErrorType.AUTHENTICATION_ERROR);
      throw new ScraperError(
        `Failed to log in to Twitter: ${(error as Error).message}`,
        ScraperErrorType.AUTHENTICATION_ERROR
      );
    }
  }
  
  /**
   * Perform a full login using the provided credentials
   * @param credentials Twitter login credentials
   */
  private async performFullLogin(credentials: AuthCredentials): Promise<void> {
    this.logger.info('Starting full login process...');
    
    // Navigate to login page
    await this.navigateWithRetry(this.loginUrl);
    
    // Wait for page to load and try multiple selectors for username input
    this.logger.info('Looking for username input field...');
    const usernameInput = await this.findFirstAvailableElement(this.usernameInputs, 15000);
    
    if (!usernameInput) {
        // Take screenshot for debugging
        const screenshotPath = await this.takeScreenshot('login_page_no_username_field');
        throw new ScraperError(
            `Could not find username input field. Screenshot saved to ${screenshotPath}`,
            ScraperErrorType.AUTHENTICATION_ERROR
        );
    }

    // Fill in username
    this.logger.info('Filling username...');
    await usernameInput.fill(credentials.username);
    
    // Find and click Next button
    const nextButton = await this.findFirstAvailableElement(this.nextButtons, 5000);
    if (!nextButton) {
        throw new ScraperError('Could not find Next button', ScraperErrorType.AUTHENTICATION_ERROR);
    }
    
    await nextButton.click();
    
    // Wait for potential verification challenge
    await this.page.waitForTimeout(2000);
    
    // Check for verification challenge (unusual login activity)
    const hasVerificationChallenge = await this.elementExists('input[data-testid="ocfEnterTextTextInput"]');
    if (hasVerificationChallenge) {
        await this.handleVerificationChallenge(credentials);
    }
    
    // Wait for password field and try multiple selectors
    this.logger.info('Looking for password input field...');
    const passwordInput = await this.findFirstAvailableElement(this.passwordInputs, 15000);
    
    if (!passwordInput) {
        // Take screenshot for debugging
        const screenshotPath = await this.takeScreenshot('login_page_no_password_field');
        throw new ScraperError(
            `Could not find password input field. Screenshot saved to ${screenshotPath}`,
            ScraperErrorType.AUTHENTICATION_ERROR
        );
    }
    
    // Fill in password
    this.logger.info('Filling password...');
    await passwordInput.fill(credentials.password);
    
    // Find and click login button
    const loginButton = await this.findFirstAvailableElement(this.loginButtons, 5000);
    if (!loginButton) {
        throw new ScraperError('Could not find login button', ScraperErrorType.AUTHENTICATION_ERROR);
    }
    
    await loginButton.click();

    // Wait for navigation to complete
    this.logger.info('Waiting for login to complete...');
    await this.page.waitForTimeout(3000);
    
    // Handle 2FA if needed
    await this.handle2FA();
    
    // Verify successful login with improved multi-check verification
    if (!(await this.verifyLoggedIn())) {
        // Take screenshot for debugging in case of failure
        const screenshotPath = await this.takeScreenshot('login_verification_failed');
        
        throw new ScraperError(
            `Login verification failed. Screenshot saved to ${screenshotPath}`,
            ScraperErrorType.AUTHENTICATION_ERROR
        );
    }
    
    this.logger.success('Successfully logged in to Twitter');
  }

  /**
 * Find the first available element from a list of locators
 * @param locators Array of locators to try
 * @param timeout Maximum time to wait for any element
 * @returns First found element or null
 */
private async findFirstAvailableElement(locators: any[], timeout: number = 10000): Promise<any> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
        for (const locator of locators) {
            try {
                await locator.waitFor({ state: 'visible', timeout: 1000 });
                this.logger.info(`Found element using locator: ${locator.toString()}`);
                return locator;
            } catch (error) {
                // Continue to next locator
            }
        }
        
        // Wait a bit before trying again
        await this.page.waitForTimeout(500);
    }
    
    this.logger.error('Could not find any element from the provided locators');
    return null;
  }
  
  /**
   * Handle the verification challenge for unusual login activity
   * @param credentials Twitter login credentials
   */
  private async handleVerificationChallenge(credentials: AuthCredentials): Promise<void> {
    this.logger.info('Detected verification challenge');
    
    // Enter username or email in the verification field
    await this.verificationInput.fill(credentials.username);
    await this.verificationNextButton.click();

    // Wait for the challenge to be processed
    await this.page.waitForLoadState('networkidle');
    
    this.logger.info('Completed verification challenge');
  }
  
  /**
   * Handle 2FA if required
   */
  private async handle2FA(): Promise<void> {
    // Check if 2FA input is present
    const has2FA = await this.twoFactorInput.isVisible();
    
    if (!has2FA) {
      return; // No 2FA required
    }
    
    this.logger.info('2FA verification required');
    
    // Prompt user to enter 2FA code manually
    // In a headless mode, this would be a problem, but we'll watch for code input
    
    // Wait for the 2FA code to be entered (max 60 seconds)
    try {
      await this.page.waitForNavigation({ timeout: 60000 });
      this.logger.info('2FA verification completed');
    } catch (error) {
      throw new ScraperError('2FA verification timed out', ScraperErrorType.AUTHENTICATION_ERROR);
    }
  }
  
  /**
   * Verify if successfully logged in using a multi-step verification strategy
   * @returns Boolean indicating if user is successfully logged in
   */
  private async verifyLoggedIn(): Promise<boolean> {
    try {
        this.logger.info('Verifying login status with multi-step checks...');
        
        // Wait a moment for page to stabilize
        await this.page.waitForTimeout(2000);
        
        // Check current URL for authenticated patterns
        const currentUrl = this.page.url();
        this.logger.info(`Current URL: ${currentUrl}`);
        
        // If we're still on login page, definitely not logged in
        if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
            this.logger.warn('Still on login page, not authenticated');
            return false;
        }
        
        // Check for authenticated routes
        const isAuthenticatedRoute = currentUrl.includes('/home') || 
                                    currentUrl.includes('/notifications') || 
                                    currentUrl.includes('/messages') ||
                                    currentUrl.includes('x.com') && !currentUrl.includes('/login');
        
        if (isAuthenticatedRoute) {
            this.logger.info('On authenticated route, checking for UI elements...');
            
            // Look for any navigation elements that indicate we're logged in
            const authElements = [
                this.homeTabLink,
                this.accountMenuButton,
                this.composeButton,
                this.notificationsTabLink
            ];
            
            for (const element of authElements) {
                try {
                    await element.waitFor({ state: 'visible', timeout: 3000 });
                    this.logger.success('Found authenticated UI element, login verified');
                    return true;
                } catch (error) {
                    // Continue checking other elements
                }
            }
        }
        
        // Try navigating to home to test authentication
        this.logger.info('Testing authentication by navigating to home...');
        await this.page.goto('https://x.com/home', { timeout: 10000 });
        await this.page.waitForTimeout(2000);
        
        const finalUrl = this.page.url();
        if (!finalUrl.includes('/login') && (finalUrl.includes('/home') || finalUrl.includes('x.com'))) {
            this.logger.success('Successfully navigated to home, authentication verified');
            return true;
        }
        
        this.logger.warn('Login verification failed - unable to confirm authenticated state');
        return false;
    } catch (error) {
        this.logger.error('Error during login verification', error as Error);
        return false;
    }
  }
  
  /**
   * Helper method to check if an element is visible with a timeout
   * @param locator The locator to check visibility for
   * @param timeoutMs Maximum time to wait in milliseconds
   * @returns Boolean indicating if the element is visible
   */
  private async isElementVisible(locator: any, timeoutMs: number = 3000): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Remove saved authentication state (logout)
   */
  public static removeAuthState(logger: any): void {
    try {
      if (fs.existsSync(TwitterAuth.storageStatePath)) {
        fs.unlinkSync(TwitterAuth.storageStatePath);
        logger.info('Removed saved authentication state.');
      }
    } catch (error) {
      logger.warn(`Failed to remove auth state file: ${(error as Error).message}`);
    }
  }
  
  /**
   * Logout from Twitter
   */
  public async logout(): Promise<void> {
    try {
      // Click on account menu
      await this.accountMenuButton.click();
      
      // Click on logout option
      await this.logoutButton.click();
      
      // Confirm logout
      await this.confirmLogoutButton.click();

      // Wait for logout to complete
      await this.page.waitForTimeout(1000); // Wait a bit for the logout process to complete

      this.logger.info('Successfully logged out from Twitter');
    } catch (error) {
      this.logger.warn(`Logout failed: ${(error as Error).message}`);
    }
    // Remove saved auth state
    TwitterAuth.removeAuthState(this.logger);
  }
}
