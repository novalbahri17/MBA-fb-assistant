const puppeteer = require("puppeteer");

// ==================== UTILITY FUNCTIONS ====================

/**
 * Promise-based delay function
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns formatted timestamp (DD/MM/YYYY HH:mm:ss)
 * @returns {string}
 */
function getFormattedTime() {
  return new Date().toLocaleString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

/**
 * Parse member count string like "1.2K anggota" or "15.5K members" to raw number
 * @param {string} text - Member count text
 * @returns {number|null}
 */
function parseMemberCount(text) {
  if (!text) return null;
  const match = text.match(/([\d.,]+)\s*[KkMm]?/);
  if (!match) return null;
  let numStr = match[1].replace(/\./g, '').replace(/,/g, '');
  const suffixMatch = text.match(/(\d[\d.,]*)\s*([KkMm])/);
  if (suffixMatch) {
    const suffix = suffixMatch[2].toUpperCase();
    const baseNum = parseFloat(suffixMatch[1].replace(/\./g, '').replace(/,/g, ''));
    if (suffix === 'K') return Math.round(baseNum * 1000);
    if (suffix === 'M') return Math.round(baseNum * 1000000);
  }
  const parsed = parseInt(numStr, 10);
  return isNaN(parsed) ? null : parsed;
}

// ==================== NETWORK HEALTH MONITOR ====================

/**
 * Monitors network health during scanning operations.
 * Tracks consecutive failures, load times, and provides adaptive delay recommendations.
 */
class NetworkHealthMonitor {
  constructor(options = {}) {
    this.failures = 0;
    this.loadTimes = [];
    this.maxConsecutiveFailures = options.maxConsecutiveFailures || 5;
    this.failureRateThreshold = options.failureRateThreshold || 0.5;
    this.metricsWindow = options.metricsWindow || 10;
    this.metrics = [];
  }

  /**
   * Record a successful operation
   * @param {number} loadTime - Operation load time in ms
   * @param {number} [elementsFound] - Number of new elements found
   */
  recordSuccess(loadTime, elementsFound = 0) {
    this.failures = 0;
    this.loadTimes.push(loadTime);
    // Keep only recent load times
    if (this.loadTimes.length > 50) {
      this.loadTimes.shift();
    }
    this.metrics.push({
      success: true,
      loadTime,
      elementsFound,
      timestamp: Date.now()
    });
    // Keep metrics window manageable
    if (this.metrics.length > this.metricsWindow * 2) {
      this.metrics = this.metrics.slice(-this.metricsWindow);
    }
  }

  /**
   * Record a failed operation
   * @param {Error|string} [error] - Error information
   */
  recordFailure(error = null) {
    this.failures++;
    this.metrics.push({
      success: false,
      error: error?.message || error,
      timestamp: Date.now()
    });
    if (this.metrics.length > this.metricsWindow * 2) {
      this.metrics = this.metrics.slice(-this.metricsWindow);
    }
  }

  /**
   * Get current health status
   * @returns {'good' | 'moderate' | 'poor'}
   */
  getHealthStatus() {
    if (this.failures >= this.maxConsecutiveFailures) {
      return 'poor';
    }

    const recent = this.metrics.slice(-this.metricsWindow);
    if (recent.length === 0) return 'good';

    const failureCount = recent.filter(m => !m.success).length;
    const failureRate = failureCount / recent.length;

    if (failureRate > this.failureRateThreshold) {
      return 'poor';
    } else if (failureRate > 0.2) {
      return 'moderate';
    }

    // Check average load time
    const avgLoadTime = this.getAverageLoadTime();
    if (avgLoadTime > 5000) {
      return 'moderate';
    }

    return 'good';
  }

  /**
   * Get average load time from recent successful operations
   * @param {number} [windowSize] - Number of recent metrics to consider
   * @returns {number} Average load time in ms
   */
  getAverageLoadTime(windowSize = null) {
    const window = windowSize || this.metricsWindow;
    const recent = this.metrics.slice(-window).filter(m => m.success && m.loadTime);
    if (recent.length === 0) return 3000; // Default 3s
    return recent.reduce((sum, m) => sum + m.loadTime, 0) / recent.length;
  }

  /**
   * Check if network is healthy enough to continue
   * @returns {boolean}
   */
  isHealthy() {
    return this.failures < this.maxConsecutiveFailures;
  }

  /**
   * Determine if backoff is needed based on recent failure rate
   * @returns {boolean}
   */
  shouldBackoff() {
    const recent = this.metrics.slice(-this.metricsWindow);
    if (recent.length < 3) return false;
    const failureRate = recent.filter(m => !m.success).length / recent.length;
    return failureRate > this.failureRateThreshold;
  }

  /**
   * Calculate adaptive delay based on current network conditions
   * @param {Object} [extraMetrics] - Additional metrics to consider
   * @param {number} [extraMetrics.scrollCount] - Current scroll iteration
   * @param {number} [extraMetrics.newElementsFound] - New elements in last operation
   * @returns {number} Delay in milliseconds
   */
  getAdaptiveDelay(extraMetrics = {}) {
    const baseDelay = 200; // Reduced from 500ms for faster scrolling
    const maxDelay = 2000; // Reduced from 5000ms for faster response

    const avgLoadTime = this.getAverageLoadTime();
    const healthStatus = this.getHealthStatus();

    // Factor 1: Network speed (slower = longer delay, but capped lower for faster scrolling)
    const networkFactor = Math.min(avgLoadTime / 1500, 2);

    // Factor 2: Health status multiplier
    let healthMultiplier = 1;
    if (healthStatus === 'moderate') healthMultiplier = 1.3;
    if (healthStatus === 'poor') healthMultiplier = 2;

    // Factor 3: Stagnation factor (fewer new elements = longer delay, consider stopping)
    const stagnationFactor = extraMetrics.newElementsFound === 0 ? 1.5 : 1;

    // Factor 4: Anti-detection jitter (random variation 0-100ms)
    const jitter = Math.random() * 100;

    const calculated = baseDelay * (1 + networkFactor) * healthMultiplier * stagnationFactor + jitter;
    return Math.min(Math.max(calculated, baseDelay), maxDelay);
  }

  /**
   * Get summary statistics
   * @returns {Object}
   */
  getStats() {
    const total = this.metrics.length;
    const successes = this.metrics.filter(m => m.success).length;
    const failures = total - successes;
    return {
      totalOperations: total,
      successes,
      failures,
      consecutiveFailures: this.failures,
      averageLoadTime: this.getAverageLoadTime(),
      healthStatus: this.getHealthStatus()
    };
  }
}

// ==================== GROUP DATA EXTRACTION ====================

/**
 * Extract group data from a DOM element using multiple strategies
 * @param {Object} element - DOM element handle from Puppeteer
 * @returns {Object|null} Group data object or null if extraction fails
 */
function extractGroupData(element) {
  // This function is called within page.evaluate context
  // It receives a plain DOM element, not a Puppeteer handle
  if (!element) return null;

  try {
    // Strategy 1: Extract from link href
    let groupUrl = null;
    let groupId = null;

    // Check if element itself is a link
    if (element.tagName === 'A') {
      groupUrl = element.getAttribute('href');
    } else {
      // Find child link
      const link = element.querySelector('a[href*="/groups/"]');
      if (link) {
        groupUrl = link.getAttribute('href');
      }
    }

    if (!groupUrl) return null;

    // Extract group ID from URL
    // Patterns: /groups/123456/, /groups/group-name/123456/, /groups/123456/posts/
    const idMatch = groupUrl.match(/\/groups\/(?:[^/]+\/)?(\d+)/);
    if (idMatch) {
      groupId = idMatch[1];
    } else {
      // Try to extract name-based ID
      const nameMatch = groupUrl.match(/\/groups\/([^/?]+)/);
      if (nameMatch && !nameMatch[1].match(/^\d+$/)) {
        // This is a vanity URL, we'll need to get the actual ID elsewhere
        groupId = nameMatch[1];
      } else {
        return null;
      }
    }

    // Strategy 2: Extract group name
    let groupName = null;

    // Try multiple approaches to get the name
    if (element.tagName === 'A') {
      groupName = element.textContent?.trim();
    }

    if (!groupName || groupName.length < 2) {
      // Look for span with group name
      const nameSpan = element.querySelector('span[dir="auto"]') ||
                       element.querySelector('span:not([class])');
      if (nameSpan) {
        groupName = nameSpan.textContent?.trim();
      }
    }

    if (!groupName || groupName.length < 2 || groupName.length > 200) {
      // Try to find any meaningful text
      const allSpans = element.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) {
          // Skip common non-name text
          if (!text.match(/^\d+$/) && !text.match(/anggota|members|posts/i)) {
            groupName = text;
            break;
          }
        }
      }
    }

    if (!groupName) {
      groupName = `Group ${groupId}`;
    }

    // Strategy 3: Extract member count
    let memberCount = null;
    let memberCountRaw = null;
    const parentText = element.parentElement?.textContent || element.textContent || '';
    const memberMatch = parentText.match(/([\d.,]+[KkMm]?)\s*(anggota|members|anggota\s)/i);
    if (memberMatch) {
      memberCount = memberMatch[0];
      memberCountRaw = parseMemberCount(memberCount);
    }

    // Strategy 4: Extract privacy status
    let privacy = 'unknown';
    const privacyIcons = element.querySelectorAll('svg');
    for (const icon of privacyIcons) {
      const ariaLabel = icon.getAttribute('aria-label');
      if (ariaLabel) {
        if (ariaLabel.toLowerCase().includes('public') || ariaLabel.toLowerCase().includes('publik')) {
          privacy = 'public';
          break;
        } else if (ariaLabel.toLowerCase().includes('private') || ariaLabel.toLowerCase().includes('pribadi')) {
          privacy = 'private';
          break;
        } else if (ariaLabel.toLowerCase().includes('closed') || ariaLabel.toLowerCase().includes('tertutup')) {
          privacy = 'closed';
          break;
        }
      }
    }

    // Also check text for privacy indicators
    if (privacy === 'unknown') {
      if (parentText.match(/publik|public/i)) {
        privacy = 'public';
      } else if (parentText.match(/pribadi|private|tertutup|closed/i)) {
        privacy = 'private';
      }
    }

    // Strategy 5: Extract avatar URL
    let avatarUrl = null;
    const img = element.querySelector('img');
    if (img) {
      avatarUrl = img.getAttribute('src') || img.getAttribute('data-src');
    }

    return {
      id: groupId,
      name: groupName,
      url: groupUrl.startsWith('http') ? groupUrl : `https://www.facebook.com${groupUrl}`,
      memberCount,
      memberCountRaw,
      privacy,
      avatar: avatarUrl
    };
  } catch (e) {
    console.error(`❌ [${getFormattedTime()}] Error extracting group data: ${e.message}`);
    return null;
  }
}

/**
 * Extract groups from page using multiple strategies
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<Map<string, Object>>} Map of group ID to group data
 */
async function extractGroupsFromPage(page) {
  const groups = new Map();

  try {
    // Strategy 1: Extract from all links containing /groups/
    const linksGroups = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/groups/"]');

      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;

        // Filter out non-group URLs
        if (href.includes('/discover/') || href.includes('/feed/') ||
            href.includes('/created/') || href.includes('/suggested/') ||
            href.includes('/browse/') || href.includes('/search/')) {
          continue;
        }

        // Extract group ID
        const idMatch = href.match(/\/groups\/(?:[^/]+\/)?(\d+)/);
        if (!idMatch) continue;

        const groupId = idMatch[1];

        // Get group name
        let name = link.textContent?.trim();
        if (!name || name.length < 2) {
          // Try parent elements
          let parent = link.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            const span = parent.querySelector('span');
            if (span && span.textContent?.trim().length > 2) {
              name = span.textContent.trim();
              break;
            }
            parent = parent.parentElement;
          }
        }

        if (!name || name.length < 2) continue;

        // Get member count from surrounding text
        let memberCount = null;
        let memberCountRaw = null;
        let searchParent = link.closest('div') || link.parentElement;
        for (let i = 0; i < 5 && searchParent; i++) {
          const text = searchParent.textContent || '';
          const memberMatch = text.match(/([\d.,]+[KkMm]?)\s*(anggota|members)/i);
          if (memberMatch) {
            memberCount = memberMatch[0];
            memberCountRaw = parseMemberCount(memberCount);
            break;
          }
          searchParent = searchParent.parentElement;
        }

        // Get privacy
        let privacy = 'unknown';
        const textContent = searchParent?.textContent || link.parentElement?.textContent || '';
        if (textContent.match(/publik|public/i)) {
          privacy = 'public';
        } else if (textContent.match(/pribadi|private|tertutup|closed/i)) {
          privacy = 'private';
        }

        // Get avatar
        let avatar = null;
        const img = link.querySelector('img') || link.parentElement?.querySelector('img');
        if (img) {
          avatar = img.getAttribute('src') || img.getAttribute('data-src');
        }

        results.push({
          id: groupId,
          name: name.substring(0, 200),
          url: href.startsWith('http') ? href : `https://www.facebook.com${href}`,
          memberCount,
          memberCountRaw,
          privacy,
          avatar
        });
      }

      return results;
    });

    for (const group of linksGroups) {
      if (group.id && !groups.has(group.id)) {
        groups.set(group.id, group);
      }
    }

    // Strategy 2: Extract from structured group list items
    const listItemsGroups = await page.evaluate(() => {
      const results = [];
      // Look for list items that contain group information
      const listItems = document.querySelectorAll('[role="listitem"], li');

      for (const li of listItems) {
        const link = li.querySelector('a[href*="/groups/"]');
        if (!link) continue;

        const href = link.getAttribute('href');
        if (!href || href.includes('/discover/') || href.includes('/feed/')) continue;

        const idMatch = href.match(/\/groups\/(?:[^/]+\/)?(\d+)/);
        if (!idMatch) continue;

        const groupId = idMatch[1];

        // Get name from structured elements
        let name = null;
        const heading = li.querySelector('h2, h3, [class*="heading"]');
        if (heading) {
          name = heading.textContent?.trim();
        }

        if (!name) {
          const spans = li.querySelectorAll('span');
          for (const span of spans) {
            const text = span.textContent?.trim();
            if (text && text.length > 2 && text.length < 200 && !text.match(/^\d+$/)) {
              name = text;
              break;
            }
          }
        }

        if (!name) continue;

        results.push({
          id: groupId,
          name: name.substring(0, 200),
          url: href.startsWith('http') ? href : `https://www.facebook.com${href}`
        });
      }

      return results;
    });

    for (const group of listItemsGroups) {
      if (group.id && !groups.has(group.id)) {
        // Merge with existing data if available
        const existing = groups.get(group.id);
        if (existing) {
          if (!existing.name && group.name) existing.name = group.name;
          if (!existing.url && group.url) existing.url = group.url;
        } else {
          groups.set(group.id, group);
        }
      }
    }

    // Strategy 3: Extract from JSON data embedded in page (if available)
    const jsonGroups = await page.evaluate(() => {
      const results = [];
      // Look for script tags or data attributes containing group info
      const scripts = document.querySelectorAll('script[type="application/json"], script[data-content]');

      for (const script of scripts) {
        try {
          const content = script.textContent || script.getAttribute('data-content');
          if (!content) continue;

          // Look for group-related JSON
          const groupMatches = content.matchAll(/"group_id"\s*:\s*"(\d+)"/g);
          for (const match of groupMatches) {
            results.push({
              id: match[1],
              source: 'json'
            });
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }

      return results;
    });

    for (const group of jsonGroups) {
      if (group.id && !groups.has(group.id)) {
        groups.set(group.id, {
          id: group.id,
          name: `Group ${group.id}`,
          url: `https://www.facebook.com/groups/${group.id}`,
          source: 'json'
        });
      }
    }

  } catch (e) {
    console.error(`❌ [${getFormattedTime()}] Error in extractGroupsFromPage: ${e.message}`);
  }

  return groups;
}

// ==================== SMART SCROLLING LOGIC ====================

/**
 * Perform smart scrolling with stagnation detection and network health monitoring
 * @param {Page} page - Puppeteer page object
 * @param {Object} options - Scrolling options
 * @param {number} [options.maxScrolls=100] - Maximum scroll iterations
 * @param {number} [options.maxStagnantScrolls=5] - Stop after this many scrolls with no new groups
 * @param {number} [options.scrollAmount=800] - Pixels to scroll per iteration
 * @param {Function} [options.onProgress] - Progress callback
 * @param {AbortSignal} [options.signal] - AbortController signal for cancellation
 * @param {NetworkHealthMonitor} [options.monitor] - Network health monitor instance
 * @returns {Promise<Map<string, Object>>} Map of all discovered groups
 */
async function smartScrollAndExtract(page, options = {}) {
  const {
    maxScrolls = 2000,
    maxStagnantScrolls = 50,
    scrollAmount = 800,
    onProgress,
    signal,
    monitor = new NetworkHealthMonitor()
  } = options;

  const allGroups = new Map();
  let scrollCount = 0;
  let stagnantScrolls = 0;
  const startTime = Date.now();
  let errors = 0;
  let lastNewGroupTime = Date.now(); // Track when we last found a new group
  const STAGNATION_TIMEOUT = 20000; // 20 seconds without new groups = stop

  console.log(`🔍 [${getFormattedTime()}] Starting smart scroll extraction...`);
  console.log(`   Max scrolls: ${maxScrolls}, Max stagnant: ${maxStagnantScrolls}`);

  while (scrollCount < maxScrolls) {
    // Check for cancellation
    if (signal?.aborted) {
      console.log(`⚠️ [${getFormattedTime()}] Scan cancelled by user after ${scrollCount} scrolls`);
      break;
    }

    // Check network health
    if (!monitor.isHealthy()) {
      console.log(`❌ [${getFormattedTime()}] Network unhealthy - ${monitor.failures} consecutive failures. Stopping scan.`);
      break;
    }

    // Check if should backoff
    if (monitor.shouldBackoff()) {
      console.log(`⏳ [${getFormattedTime()}] High failure rate detected, backing off for 3 seconds...`);
      await delay(3000);
    }

    const extractionStart = Date.now();

    try {
      // Extract groups from current page state
      const newGroups = await extractGroupsFromPage(page);
      const loadTime = Date.now() - extractionStart;
      let newCount = 0;

      for (const [id, group] of newGroups) {
        if (!allGroups.has(id)) {
          allGroups.set(id, group);
          newCount++;
        }
      }

      monitor.recordSuccess(loadTime, newCount);

      // Update last new group time
      if (newCount > 0) {
        lastNewGroupTime = Date.now();
        stagnantScrolls = 0;
      }

      // Report progress - include groups array for real-time updates
      const groupsArray = Array.from(allGroups.values()).map(group => ({
        group_id: group.id,
        group_name: group.name,
        group_url: group.url,
        member_count: group.memberCount,
        member_count_raw: group.memberCountRaw,
        group_type: group.privacy,
        avatar_url: group.avatar,
        is_joined: true,
        scanned_at: new Date().toISOString()
      }));
      
      const timeSinceLastNewGroup = Date.now() - lastNewGroupTime;
      
      onProgress?.({
        phase: 'scrolling',
        scrollCount: scrollCount + 1,
        totalGroups: allGroups.size,
        newGroupsThisScroll: newCount,
        networkHealth: monitor.getHealthStatus(),
        duration: Date.now() - startTime,
        groups: groupsArray,
        timeSinceLastNewGroup: timeSinceLastNewGroup
      });

      // Log progress every 10 scrolls or when new groups found
      if (scrollCount % 10 === 0 || newCount > 0) {
        console.log(`📊 [${getFormattedTime()}] Scroll ${scrollCount + 1}: ${newCount} new groups, ${allGroups.size} total (${(timeSinceLastNewGroup/1000).toFixed(1)}s since last new)`);
      }

      // Check for time-based stagnation (20 seconds without new groups)
      if (timeSinceLastNewGroup >= STAGNATION_TIMEOUT) {
        console.log(`✅ [${getFormattedTime()}] No new groups found in ${(timeSinceLastNewGroup/1000).toFixed(1)}s (timeout: 20s). Scan complete.`);
        break;
      }

      // Also check scroll-based stagnation as fallback
      if (newCount === 0) {
        stagnantScrolls++;
        if (stagnantScrolls >= maxStagnantScrolls) {
          console.log(`✅ [${getFormattedTime()}] No new groups found in ${maxStagnantScrolls} consecutive scrolls. Scan complete.`);
          break;
        }
      }

      // Calculate adaptive delay
      const adaptiveDelay = monitor.getAdaptiveDelay({
        scrollCount,
        newElementsFound: newCount
      });

      // Scroll down
      await page.evaluate((amount) => {
        window.scrollBy(0, amount);
      }, scrollAmount);

      await delay(adaptiveDelay);
      scrollCount++;

    } catch (e) {
      errors++;
      monitor.recordFailure(e);
      console.error(`❌ [${getFormattedTime()}] Error during scroll ${scrollCount + 1}: ${e.message}`);

      // Try to recover with a longer delay
      await delay(5000);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`✅ [${getFormattedTime()}] Scrolling complete: ${allGroups.size} groups found in ${scrollCount} scrolls (${(duration / 1000).toFixed(1)}s)`);

  return {
    groups: allGroups,
    stats: {
      scrolls: scrollCount,
      duration,
      errors,
      networkHealth: monitor.getStats()
    }
  };
}

// ==================== MAIN SCANNING FUNCTION ====================

/**
 * Scan all joined Facebook groups with network-adaptive delays
 *
 * @param {Page} page - Puppeteer page object (must be on Facebook)
 * @param {Object} [options] - Configuration options
 * @param {number} [options.maxScrolls=100] - Maximum scroll iterations
 * @param {number} [options.maxStagnantScrolls=5] - Stop after N scrolls with no new groups
 * @param {number} [options.baseDelay=500] - Base delay between scrolls (ms)
 * @param {boolean} [options.adaptiveDelay=true] - Enable network-adaptive delays
 * @param {number} [options.maxRetries=3] - Max retries for navigation
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout (ms)
 * @param {Function} [options.onProgress] - Progress callback (scanned, total)
 * @param {AbortSignal} [options.signal] - AbortController signal for cancellation
 * @returns {Promise<Object>} Result with groups array and stats
 */
async function scanJoinedGroups(page, options = {}) {
  const {
    maxScrolls = 100,
    maxStagnantScrolls = 5,
    baseDelay = 500,
    adaptiveDelay = true,
    maxRetries = 3,
    navigationTimeout = 30000,
    onProgress,
    signal
  } = options;

  const startTime = Date.now();
  const monitor = new NetworkHealthMonitor();
  let errors = 0;

  console.log(`🚀 [${getFormattedTime()}] Starting joined groups scan...`);

  try {
    // Navigate to Facebook groups page
    let retries = 0;
    let navigationSuccess = false;

    while (retries < maxRetries && !navigationSuccess) {
      if (signal?.aborted) {
        throw new Error('Scan cancelled by user during navigation');
      }

      try {
        console.log(`📍 [${getFormattedTime()}] Navigating to Facebook groups page (attempt ${retries + 1})...`);

        // Go to the joined groups page
        await Promise.all([
          page.goto('https://www.facebook.com/groups/joins/', {
            waitUntil: 'networkidle2',
            timeout: navigationTimeout
          }),
          // Wait for some group content to appear
          page.waitForSelector('a[href*="/groups/"]', { timeout: navigationTimeout })
            .catch(() => {
              // Try alternative selector
              return page.waitForSelector('[role="listitem"]', { timeout: 5000 })
                .catch(() => null);
            })
        ]);

        navigationSuccess = true;
        console.log(`✅ [${getFormattedTime()}] Successfully navigated to groups page`);

      } catch (navError) {
        retries++;
        errors++;
        monitor.recordFailure(navError);
        console.error(`❌ [${getFormattedTime()}] Navigation attempt ${retries} failed: ${navError.message}`);

        if (retries < maxRetries) {
          const backoffDelay = 2000 * retries;
          console.log(`⏳ [${getFormattedTime()}] Retrying in ${backoffDelay}ms...`);
          await delay(backoffDelay);
        }
      }
    }

    if (!navigationSuccess) {
      throw new Error(`Failed to navigate to groups page after ${maxRetries} attempts`);
    }

    // Wait a moment for page to fully render
    await delay(1000);

    // Perform smart scrolling and extraction
    const scrollResult = await smartScrollAndExtract(page, {
      maxScrolls,
      maxStagnantScrolls,
      onProgress: (progress) => {
        // Pass full progress object to server, not just (scrolled, total)
        onProgress?.(progress);
      },
      signal,
      monitor
    });

    // Convert Map to array of group objects
    const groupsArray = Array.from(scrollResult.groups.values()).map(group => ({
      group_id: group.id,
      group_name: group.name,
      group_url: group.url,
      member_count: group.memberCount,
      member_count_raw: group.memberCountRaw,
      group_type: group.privacy,
      avatar_url: group.avatar,
      is_joined: true,
      scanned_at: new Date().toISOString()
    }));

    const totalDuration = Date.now() - startTime;

    console.log(`✅ [${getFormattedTime()}] Scan complete! Found ${groupsArray.length} groups`);
    console.log(`   Duration: ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`   Scrolls: ${scrollResult.stats.scrolls}`);
    console.log(`   Errors: ${scrollResult.stats.errors}`);

    return {
      groups: groupsArray,
      stats: {
        scanned: groupsArray.length,
        duration: totalDuration,
        scrolls: scrollResult.stats.scrolls,
        errors: scrollResult.stats.errors + errors,
        networkHealth: monitor.getStats()
      }
    };

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`❌ [${getFormattedTime()}] Scan failed: ${error.message}`);

    // Return partial results if we have any
    const partialGroups = [];
    try {
      const partialResult = await extractGroupsFromPage(page);
      for (const [id, group] of partialResult) {
        partialGroups.push({
          group_id: group.id,
          group_name: group.name,
          group_url: group.url,
          member_count: group.memberCount,
          member_count_raw: group.memberCountRaw,
          group_type: group.privacy,
          avatar_url: group.avatar,
          is_joined: true,
          scanned_at: new Date().toISOString()
        });
      }
    } catch (e) {
      // Ignore partial extraction errors
    }

    return {
      groups: partialGroups,
      stats: {
        scanned: partialGroups.length,
        duration: totalDuration,
        errors: errors + 1,
        error: error.message,
        networkHealth: monitor.getStats()
      }
    };
  }
}

// ==================== GROUP SEARCH FUNCTION ====================

/**
 * Search for Facebook groups by keyword
 *
 * @param {Page} page - Puppeteer page object
 * @param {Object} options
 * @param {string} options.keyword - Search keyword
 * @param {number} [options.maxResults=100] - Maximum groups to find
 * @param {boolean} [options.autoJoin=false] - Auto-join found groups
 * @param {Function} [options.onProgress] - Progress callback
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @returns {Promise<Object>} Search results
 */
async function searchAndJoinGroups(page, options = {}) {
  const {
    keyword,
    maxResults = 100,
    autoJoin = false,
    onProgress,
    signal
  } = options;

  if (!keyword) {
    throw new Error('Keyword is required for group search');
  }

  console.log(`🔍 [${getFormattedTime()}] Searching for groups with keyword: "${keyword}"`);

  const foundGroups = new Map();
  let errors = 0;
  const startTime = Date.now();

  try {
    // Navigate to search results
    const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`;

    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    console.log(`✅ [${getFormattedTime()}] Search results loaded`);

    // Wait for results to appear
    await delay(2000);

    // Scroll and extract
    let scrollCount = 0;
    let stagnantScrolls = 0;
    const maxScrolls = 50;
    const maxStagnant = 5;

    while (scrollCount < maxScrolls && foundGroups.size < maxResults) {
      if (signal?.aborted) {
        console.log(`⚠️ [${getFormattedTime()}] Search cancelled by user`);
        break;
      }

      const groups = await extractGroupsFromPage(page);
      let newCount = 0;

      for (const [id, group] of groups) {
        if (!foundGroups.has(id) && foundGroups.size < maxResults) {
          foundGroups.set(id, group);
          newCount++;
        }
      }

      if (newCount === 0) {
        stagnantScrolls++;
        if (stagnantScrolls >= maxStagnant) break;
      } else {
        stagnantScrolls = 0;
      }

      onProgress?.({
        phase: 'searching',
        found: foundGroups.size,
        keyword,
        scrollCount: scrollCount + 1
      });

      await page.evaluate(() => window.scrollBy(0, 800));
      await delay(1000 + Math.random() * 1000);
      scrollCount++;
    }

    // Auto-join if requested
    if (autoJoin && foundGroups.size > 0) {
      console.log(`📝 [${getFormattedTime()}] Auto-joining ${foundGroups.size} groups...`);
      // Implementation would depend on Facebook's join button structure
      // This is a placeholder for future implementation
    }

    const groupsArray = Array.from(foundGroups.values()).map(group => ({
      group_id: group.id,
      group_name: group.name,
      group_url: group.url,
      member_count: group.memberCount,
      member_count_raw: group.memberCountRaw,
      group_type: group.privacy,
      avatar_url: group.avatar,
      is_joined: false,
      scanned_at: new Date().toISOString()
    }));

    return {
      groups: groupsArray,
      stats: {
        found: groupsArray.length,
        duration: Date.now() - startTime,
        errors
      }
    };

  } catch (error) {
    console.error(`❌ [${getFormattedTime()}] Search failed: ${error.message}`);
    return {
      groups: Array.from(foundGroups.values()),
      stats: {
        found: foundGroups.size,
        duration: Date.now() - startTime,
        errors: errors + 1,
        error: error.message
      }
    };
  }
}

// ==================== GROUP DETAILS EXTRACTION ====================

/**
 * Extract detailed information from a specific group page
 *
 * @param {Page} page - Puppeteer page object
 * @param {string} groupId - Group ID to extract details for
 * @returns {Promise<Object>} Group details
 */
async function extractGroupDetails(page, groupId) {
  console.log(`📋 [${getFormattedTime()}] Extracting details for group ${groupId}...`);

  try {
    const groupUrl = `https://www.facebook.com/groups/${groupId}`;

    await page.goto(groupUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await delay(2000);

    const details = await page.evaluate(() => {
      const result = {
        name: null,
        description: null,
        memberCount: null,
        memberCountRaw: null,
        privacy: 'unknown',
        category: null
      };

      // Extract name
      const heading = document.querySelector('h1, h2, [class*="heading"]');
      if (heading) {
        result.name = heading.textContent?.trim();
      }

      // Extract member count
      const bodyText = document.body.textContent || '';
      const memberMatch = bodyText.match(/([\d.,]+[KkMm]?)\s*(anggota|members)/i);
      if (memberMatch) {
        result.memberCount = memberMatch[0];
        result.memberCountRaw = parseMemberCount(memberMatch[1]);
      }

      // Extract privacy
      if (bodyText.match(/publik|public/i)) {
        result.privacy = 'public';
      } else if (bodyText.match(/pribadi|private|tertutup|closed/i)) {
        result.privacy = 'private';
      }

      return result;
    });

    return {
      group_id: groupId,
      group_name: details.name,
      group_url: `https://www.facebook.com/groups/${groupId}`,
      member_count: details.memberCount,
      member_count_raw: details.memberCountRaw,
      group_type: details.privacy,
      category: details.category,
      description: details.description,
      is_joined: true,
      scanned_at: new Date().toISOString()
    };

  } catch (error) {
    console.error(`❌ [${getFormattedTime()}] Failed to extract group details: ${error.message}`);
    return {
      group_id: groupId,
      error: error.message
    };
  }
}

// ==================== EXPORTS ====================

module.exports = {
  // Main scanning function
  scanJoinedGroups,

  // Search function
  searchAndJoinGroups,

  // Group details extraction
  extractGroupDetails,

  // Network health monitor
  NetworkHealthMonitor,

  // Utility functions
  extractGroupData,
  extractGroupsFromPage,
  smartScrollAndExtract,
  parseMemberCount,
  delay,
  getFormattedTime
};
