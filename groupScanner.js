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
  // Format yang didukung:
  //   Indonesia: "57 rb anggota", "1,2 jt anggota", "1.234 anggota"
  //   English:   "57K members", "1.2M members", "1,234 members"
  const suffixMatch = text.match(/([\d.,]+)\s*(rb|jt|ribu|juta|k|m)\b/i);
  if (suffixMatch) {
    const baseNum = parseFloat(suffixMatch[1].replace(/\./g, '').replace(/,/g, '.'));
    if (isNaN(baseNum)) return null;
    const suffix = suffixMatch[2].toLowerCase();
    if (suffix === 'rb' || suffix === 'ribu' || suffix === 'k') return Math.round(baseNum * 1000);
    if (suffix === 'jt' || suffix === 'juta' || suffix === 'm') return Math.round(baseNum * 1000000);
  }
  const plainMatch = text.match(/([\d.,]+)/);
  if (!plainMatch) return null;
  const parsed = parseInt(plainMatch[1].replace(/\./g, '').replace(/,/g, ''), 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parse "90+ postingan per hari" / "10+ posts per day" menjadi angka (90, 10, dst).
 * Dipakai sebagai sinyal aktivitas grup (makin tinggi makin aktif).
 */
function parsePostsPerDay(text) {
  if (!text) return null;
  const match = text.match(/(\d+)\s*\+?\s*(postingan|posts|posting)/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
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

    // Strategy 3: Extract member count (inline parse — browser context)
    let memberCount = null;
    let memberCountRaw = null;
    const parentText = element.parentElement?.textContent || element.textContent || '';
    const memberMatch = parentText.match(/([\d.,]+\s*(?:rb|jt|ribu|juta|[KkMm])?)\s*(anggota|members)/i);
    if (memberMatch) {
      memberCount = memberMatch[0];
      const sm = memberMatch[0].match(/([\d.,]+)\s*(rb|jt|ribu|juta|k|m)\b/i);
      if (sm) {
        const base = parseFloat(sm[1].replace(/\./g, '').replace(/,/g, '.'));
        const suf = sm[2].toLowerCase();
        memberCountRaw = (suf === 'rb' || suf === 'ribu' || suf === 'k') ? Math.round(base * 1000)
          : (suf === 'jt' || suf === 'juta' || suf === 'm') ? Math.round(base * 1000000) : Math.round(base);
      } else {
        const pm = memberMatch[0].match(/([\d.,]+)/);
        memberCountRaw = pm ? parseInt(pm[1].replace(/\./g, '').replace(/,/g, ''), 10) : null;
      }
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

        // Get member count + posts/day RAW TEXT from surrounding card text
        // Format FB Indonesia: "Publik · 57 rb anggota · 90+ postingan per hari"
        // NOTE: parsing dilakukan di sisi Node (parseMemberCount/parsePostsPerDay
        // tidak tersedia di browser context)
        let memberCountText = null;
        let postsText = null;
        let searchParent = link.closest('div') || link.parentElement;
        for (let i = 0; i < 8 && searchParent; i++) {
          const text = searchParent.textContent || '';
          if (memberCountText === null) {
            const memberMatch = text.match(/([\d.,]+\s*(?:rb|jt|ribu|juta|[KkMm])?)\s*(anggota|members)/i);
            if (memberMatch) memberCountText = memberMatch[0];
          }
          if (postsText === null) {
            const postsMatch = text.match(/(\d+)\s*\+?\s*(postingan|posts|posting)\s*per\s*(hari|day|week)/i);
            if (postsMatch) postsText = postsMatch[0];
          }
          if (memberCountText !== null && postsText !== null) break;
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

        // Deteksi apakah grup SUDAH di-join: tombol di kartu sudah jadi
        // "Lihat"/"Joined"/"Permintaan terkirim" (bukan "Gabung" lagi)
        let alreadyJoined = false;
        let card = link;
        for (let i = 0; i < 10 && card.parentElement; i++) {
          card = card.parentElement;
          const cardText = card.innerText || '';
          if (card.offsetHeight > 40 && /gabung|join|lihat/i.test(cardText)) break;
        }
        const cardButtons = Array.from(card.querySelectorAll('[role="button"], button, a[role="button"]'));
        for (const btn of cardButtons) {
          const bt = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
          if (bt.includes('lihat') || bt.includes('joined') || bt.includes('terkirim') ||
              bt.includes('request sent') || bt.includes('pending')) {
            alreadyJoined = true;
            break;
          }
        }

        // Deteksi grup PENUH: Facebook menampilkan "Grup penuh"/"Group full"
        // di kartu (grup mencapai batas 2 juta anggota) — tidak bisa di-join
        const fullCardText = (card.innerText || '').toLowerCase();
        const isFull = fullCardText.includes('grup penuh') || fullCardText.includes('group full') ||
                       fullCardText.includes('kelompok ini penuh') || fullCardText.includes('this group is full');

        results.push({
          id: groupId,
          name: name.substring(0, 200),
          url: href.startsWith('http') ? href : `https://www.facebook.com${href}`,
          memberCountText,
          postsText,
          privacy,
          avatar,
          alreadyJoined,
          isFull
        });
      }

      return results;
    });

    for (const group of linksGroups) {
      // Parse di sisi Node (browser context tidak punya fungsi parser)
      group.memberCount = group.memberCountText || null;
      group.memberCountRaw = group.memberCountText ? parseMemberCount(group.memberCountText) : null;
      group.postsPerDay = group.postsText ? parsePostsPerDay(group.postsText) : null;
      delete group.memberCountText;
      delete group.postsText;
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

// ==================== FILTERED GROUP SEARCH (for Auto Join) ====================

/**
 * Search groups by keyword and collect them with member count data.
 * Designed for the Auto Join feature — collects as many groups as possible
 * (up to maxResults) so the server can filter & sort them.
 *
 * @param {Page} page - Puppeteer page object (already logged in)
 * @param {Object} options - Search options
 * @param {string} options.keyword - Search keyword
 * @param {number} [options.maxResults=200] - Maximum groups to collect
 * @param {number} [options.maxScrolls=100] - Maximum scroll iterations
 * @param {number} [options.maxStagnantScrolls=8] - Stop after N scrolls with no new groups
 * @param {boolean} [options.nearby=false] - Filter "Di sekitar saya" (grup lokal)
 * @param {boolean} [options.publicOnly=false] - Filter "Grup publik" (hanya grup publik)
 * @param {Function} [options.onProgress] - Progress callback
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @returns {Promise<Object>} { groups: Array, stats: Object }
 */
async function searchGroupsFiltered(page, options = {}) {
  const {
    keyword,
    maxResults = 200,
    maxScrolls = 100,
    maxStagnantScrolls = 8,
    nearby = false,
    publicOnly = false,
    onProgress,
    signal
  } = options;

  if (!keyword) {
    throw new Error('Keyword is required for group search');
  }

  console.log(`🔍 [${getFormattedTime()}] Searching groups (filtered mode): "${keyword}" (max ${maxResults})`);

  const foundGroups = new Map();
  const startTime = Date.now();
  let scrollCount = 0;
  let stagnantScrolls = 0;
  let totalSkippedJoined = 0;
  let totalSkippedFull = 0;

  try {
    let searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`;

    // Filter Facebook ("Di sekitar saya" & "Grup publik") — sama persis dengan
    // toggle di sidebar filter Facebook. Facebook menerapkannya lewat param URL
    // `filters=` (base64 JSON), jadi kita bisa langsung append ke URL tanpa
    // perlu klik switch di halaman. Token diverifikasi langsung dari Facebook:
    //   - "Di sekitar saya" = filter_groups_local
    //   - "Grup publik"     = public_groups
    const filtersObj = {};
    if (nearby) {
      filtersObj['filter_groups_local:0'] = JSON.stringify({ name: 'filter_groups_local', args: '' });
    }
    if (publicOnly) {
      filtersObj['public_groups:0'] = JSON.stringify({ name: 'public_groups', args: '' });
    }
    if (Object.keys(filtersObj).length > 0) {
      searchUrl += `&filters=${encodeURIComponent(Buffer.from(JSON.stringify(filtersObj)).toString('base64'))}`;
      const activeFilters = [nearby ? '"Di sekitar saya"' : null, publicOnly ? '"Grup publik"' : null].filter(Boolean).join(' + ');
      console.log(`🎛️ [${getFormattedTime()}] Filter Facebook AKTIF: ${activeFilters}`);
    }

    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await delay(3000);

    while (scrollCount < maxScrolls && foundGroups.size < maxResults) {
      if (signal?.aborted) {
        console.log(`⚠️ [${getFormattedTime()}] Search cancelled by user`);
        break;
      }

      const groups = await extractGroupsFromPage(page);
      let newCount = 0;

      for (const [id, group] of groups) {
        if (foundGroups.has(id)) continue;

        // Grup yang SUDAH di-join (tombol sudah jadi "Lihat"/"Terkirim")
        // TIDAK dihitung sebagai grup ditemukan — langsung dilewati
        if (group.alreadyJoined) {
          totalSkippedJoined++;
          continue;
        }

        // Grup PENUH (batas anggota Facebook) tidak bisa di-join — dilewati juga
        if (group.isFull) {
          totalSkippedFull++;
          continue;
        }

        if (foundGroups.size < maxResults) {
          // position = urutan ditemukan (1 = paling awal di hasil pencarian = paling aktif/relevan)
          group.position = foundGroups.size + 1;
          foundGroups.set(id, group);
          newCount++;
        }
      }

      if (newCount === 0) {
        stagnantScrolls++;
        if (stagnantScrolls >= maxStagnantScrolls) {
          console.log(`ℹ️ [${getFormattedTime()}] No new groups after ${stagnantScrolls} scrolls — stopping`);
          break;
        }
      } else {
        stagnantScrolls = 0;
      }

      onProgress?.({
        phase: 'searching',
        found: foundGroups.size,
        skippedJoined: totalSkippedJoined,
        skippedFull: totalSkippedFull,
        maxResults,
        keyword,
        scrollCount: scrollCount + 1
      });

      // Kalau target sudah tercapai, berhenti — tidak perlu scroll lagi
      if (foundGroups.size >= maxResults) {
        console.log(`✅ [${getFormattedTime()}] Target ${maxResults} grup tercapai — berhenti scroll`);
        break;
      }

      // Scroll ke paling bawah agar Facebook memuat hasil berikutnya (infinite scroll)
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1500 + Math.random() * 1500);
      scrollCount++;
    }

    const groupsArray = Array.from(foundGroups.values()).map(group => ({
      group_id: group.id,
      group_name: group.name,
      group_url: group.url,
      member_count: group.memberCount,
      member_count_raw: group.memberCountRaw,
      posts_per_day: group.postsPerDay || null,
      group_type: group.privacy,
      avatar_url: group.avatar,
      position: group.position || null,
      is_joined: false,
      scanned_at: new Date().toISOString()
    }));

    console.log(`✅ [${getFormattedTime()}] Search complete: ${groupsArray.length} groups collected in ${Math.round((Date.now() - startTime) / 1000)}s (${totalSkippedJoined} grup sudah di-join dilewati, ${totalSkippedFull} grup penuh dilewati)`);

    return {
      groups: groupsArray,
      stats: {
        found: groupsArray.length,
        skippedJoined: totalSkippedJoined,
        skippedFull: totalSkippedFull,
        scrolls: scrollCount,
        duration: Date.now() - startTime
      }
    };

  } catch (error) {
    console.error(`❌ [${getFormattedTime()}] Filtered search failed: ${error.message}`);
    return {
      groups: Array.from(foundGroups.values()).map(group => ({
        group_id: group.id,
        group_name: group.name,
        group_url: group.url,
        member_count: group.memberCount,
        member_count_raw: group.memberCountRaw,
        posts_per_day: group.postsPerDay || null,
        group_type: group.privacy,
        avatar_url: group.avatar,
        position: group.position || null,
        is_joined: false,
        scanned_at: new Date().toISOString()
      })),
      stats: {
        found: foundGroups.size,
        scrolls: scrollCount,
        duration: Date.now() - startTime,
        error: error.message
      }
    };
  }
}

// ==================== SPAM DETECTION ====================

// Indikator akun diblokir / dibatasi Facebook (locale id_ID + en_US)
const SPAM_INDICATORS = [
  'sementara diblokir', 'temporarily blocked',
  'aktivitas tidak biasa', 'unusual activity',
  'limits to prevent misuse', 'batas untuk mencegah penyalahgunaan',
  'coba lagi nanti', 'try again later',
  'tindakan dibatasi', 'action blocked', 'action restricted',
  'kami membatasi', 'terlalu banyak tindakan', 'too many actions',
  'amankan akun', 'secure your account', 'checkpoint'
];

/**
 * Cek apakah halaman Facebook sedang menampilkan peringatan spam/blokir
 * (banner di body atau dialog popup). Dipakai sebelum & sesudah klik Gabung.
 * @param {Page} page
 * @returns {Promise<{spam: boolean, indicator?: string, inDialog?: boolean}>}
 */
async function detectSpamOnPage(page) {
  try {
    return await page.evaluate((indicators) => {
      const text = (document.body.innerText || '').toLowerCase();
      for (const ind of indicators) {
        if (text.includes(ind)) return { spam: true, indicator: ind };
      }
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      for (const dlg of dialogs) {
        const dt = (dlg.innerText || '').toLowerCase();
        for (const ind of indicators) {
          if (dt.includes(ind)) return { spam: true, indicator: ind, inDialog: true };
        }
      }
      return { spam: false };
    }, SPAM_INDICATORS);
  } catch (e) {
    return { spam: false };
  }
}

// ==================== JOIN FROM SEARCH PAGE ====================

/**
 * Join grup LANGSUNG dari halaman hasil pencarian (tanpa membuka halaman grup).
 * Di halaman search, setiap kartu grup punya tombol "Gabung"/"Join".
 * Setelah diklik, tombol berubah jadi "Lihat"/"Joined" / "Permintaan terkirim" —
 * itu tandanya sudah tergabung (atau request terkirim untuk grup privat).
 *
 * @param {Page} page - Puppeteer page (harus sedang berada di halaman search groups)
 * @param {string} groupId - ID grup yang mau di-join
 * @param {Object} [options] - Opsi tambahan
 * @param {string} [options.autoAnswer] - Jawaban otomatis untuk pertanyaan masuk grup (screening questions)
 * @returns {Promise<Object>} { success, groupId, alreadyJoined, pendingApproval, groupFull, answeredQuestions, error }
 */
async function joinGroupFromSearchPage(page, groupId, options = {}) {
  const { autoAnswer = 'Setuju dengan semua aturan grup dan ingin bergabung untuk berdiskusi.' } = options;
  try {
    // Deteksi spam/blocked dulu (banner di body atau dialog dari Facebook)
    const spamCheck = await detectSpamOnPage(page);
    if (spamCheck.spam) {
      return { success: false, groupId, spamDetected: true, error: `Akun terdeteksi spam/blocked (${spamCheck.indicator})` };
    }

    // Pastikan kartu grup ada di DOM — kalau belum, scroll dari atas sampai ketemu
    let cardInDom = await page.evaluate((gid) => {
      return Array.from(document.querySelectorAll('a[href*="/groups/"]'))
        .some(a => (a.getAttribute('href') || '').includes(`/groups/${gid}`));
    }, groupId);

    if (!cardInDom) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await delay(1000);
      for (let s = 0; s < 80 && !cardInDom; s++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await delay(700);
        cardInDom = await page.evaluate((gid) => {
          return Array.from(document.querySelectorAll('a[href*="/groups/"]'))
            .some(a => (a.getAttribute('href') || '').includes(`/groups/${gid}`));
        }, groupId);
      }
    }

    if (!cardInDom) {
      return { success: false, groupId, error: 'Kartu grup tidak ditemukan di halaman search' };
    }

    const result = await page.evaluate((gid) => {
      // Cari semua link menuju grup ini
      const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'))
        .filter(a => (a.getAttribute('href') || '').includes(`/groups/${gid}`));
      if (links.length === 0) {
        return { success: false, error: 'Kartu grup tidak ditemukan di halaman (scroll belum sampai?)' };
      }

      // Naik ke container kartu (card) yang memuat tombol Gabung
      let card = links[0];
      for (let i = 0; i < 10 && card.parentElement; i++) {
        card = card.parentElement;
        const cardText = (card.innerText || '');
        if (/gabung|join|lihat/i.test(cardText) && card.offsetHeight > 40) break;
      }

      const buttons = Array.from(card.querySelectorAll('[role="button"], button, a[role="button"]'));

      // 0) Cek apakah grup PENUH — Facebook menampilkan "Grup penuh"/"Group full"
      // dan biasanya tidak ada tombol Gabung sama sekali
      const cardTextLower = (card.innerText || '').toLowerCase();
      if (cardTextLower.includes('grup penuh') || cardTextLower.includes('group full') ||
          cardTextLower.includes('kelompok ini penuh') || cardTextLower.includes('this group is full')) {
        return { success: false, groupFull: true, error: 'Grup penuh (mencapai batas anggota Facebook)' };
      }

      // 1) Cek apakah sudah tergabung: tombol bertuliskan "Lihat"/"Joined"/"Permintaan terkirim"
      for (const btn of buttons) {
        const t = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
        if (t.includes('lihat') || t.includes('joined') || t.includes('terkirim') ||
            t.includes('request sent') || t.includes('pending')) {
          return { success: true, alreadyJoined: true,
                   pendingApproval: t.includes('terkirim') || t.includes('request') || t.includes('pending') };
        }
      }

      // 2) Klik tombol "Gabung"/"Join"
      for (const btn of buttons) {
        const t = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
        if (t.includes('gabung') || t.includes('join')) {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return { success: true, clicked: true };
        }
      }

      return { success: false, error: 'Tombol Gabung tidak ditemukan di kartu grup' };
    }, groupId);

    if (!result.success || result.alreadyJoined) return { ...result, groupId };
    if (!result.clicked) return { ...result, groupId };

    // Grup privat sering memunculkan dialog konfirmasi ("Setuju & bergabung" / aturan grup)
    await delay(1500);

    // Cek dulu apakah dialog yang muncul adalah peringatan "grup penuh"
    const fullDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      for (const dlg of dialogs) {
        const t = (dlg.innerText || '').toLowerCase();
        if (t.includes('grup penuh') || t.includes('group full') ||
            t.includes('kelompok ini penuh') || t.includes('this group is full')) {
          // Tutup dialog (klik tombol X / "Tutup" / "Close" / "OK")
          const btns = Array.from(dlg.querySelectorAll('[role="button"], button'));
          for (const btn of btns) {
            const bt = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
            if (bt.includes('tutup') || bt.includes('close') || bt.includes('ok') ||
                bt.includes('mengerti') || bt.includes('got it') || btn.getAttribute('aria-label')?.toLowerCase().includes('close')) {
              btn.click();
              return true;
            }
          }
          return true;
        }
      }
      return false;
    });

    if (fullDialog) {
      return { success: false, groupId, groupFull: true, error: 'Grup penuh (mencapai batas anggota Facebook)' };
    }

    // Tangani dialog pertanyaan grup / persetujuan aturan (Screening Questions & Group Rules)
    const dialogResult = await page.evaluate((answerText) => {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      if (dialogs.length === 0) return { handled: false, answered: false };

      let answeredAny = false;

      for (const dlg of dialogs) {
        // 1) Cek dan centang semua checkbox persetujuan aturan ("Saya setuju dengan aturan grup", dll)
        const checkboxes = dlg.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
        for (const cb of checkboxes) {
          const isChecked = cb.checked || cb.getAttribute('aria-checked') === 'true';
          if (!isChecked) {
            cb.click();
            answeredAny = true;
          }
        }

        // 2) Isi semua input text / textarea / contenteditable untuk pertanyaan masuk grup
        const textInputs = dlg.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
        for (const input of textInputs) {
          if (input.getAttribute('contenteditable') === 'true') {
            if (!input.innerText || input.innerText.trim().length === 0) {
              input.innerText = answerText;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              answeredAny = true;
            }
          } else {
            if (!input.value || input.value.trim().length === 0) {
              input.value = answerText;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              answeredAny = true;
            }
          }
        }

        // 3) Pilih opsi radio jika ada pertanyaan pilihan ganda (pilih opsi pertama / yang positif)
        const radioGroups = dlg.querySelectorAll('[role="radiogroup"], fieldset');
        for (const rg of radioGroups) {
          const radios = rg.querySelectorAll('input[type="radio"], [role="radio"]');
          const hasChecked = Array.from(radios).some(r => r.checked || r.getAttribute('aria-checked') === 'true');
          if (!hasChecked && radios.length > 0) {
            // Prioritaskan radio yang mengandung teks "ya" / "setuju" / "yes" / "agree"
            let chosen = radios[0];
            for (const r of radios) {
              const label = (r.closest('label')?.textContent || r.parentElement?.textContent || '').toLowerCase();
              if (label.includes('ya') || label.includes('setuju') || label.includes('yes') || label.includes('agree')) {
                chosen = r;
                break;
              }
            }
            chosen.click();
            answeredAny = true;
          }
        }

        // 4) Klik tombol kirim / submit / setuju / konfirmasi
        const btns = Array.from(dlg.querySelectorAll('[role="button"], button'));
        for (const btn of btns) {
          const t = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
          if (t.includes('kirim') || t.includes('submit') || t.includes('send') ||
              t.includes('setuju') || t.includes('agree') || t.includes('gabung') ||
              t.includes('join') || t.includes('konfirmasi') || t.includes('confirm') ||
              t.includes('selesai') || t.includes('done')) {
            btn.click();
            return { handled: true, answered: answeredAny };
          }
        }
      }

      return { handled: true, answered: answeredAny };
    }, autoAnswer);

    // Tunggu reaksi Facebook, lalu cek apakah muncul peringatan spam SETELAH klik
    await delay(2500);

    const spamAfter = await detectSpamOnPage(page);
    if (spamAfter.spam) {
      return { success: false, groupId, spamDetected: true, error: `Spam terdeteksi setelah klik (${spamAfter.indicator})` };
    }

    const verify = await page.evaluate((gid) => {
      const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'))
        .filter(a => (a.getAttribute('href') || '').includes(`/groups/${gid}`));
      if (links.length === 0) return { changed: false };

      let card = links[0];
      for (let i = 0; i < 10 && card.parentElement; i++) {
        card = card.parentElement;
        const cardText = (card.innerText || '');
        if (/gabung|join|lihat/i.test(cardText) && card.offsetHeight > 40) break;
      }

      const cardText = (card.innerText || '').toLowerCase();
      const buttons = Array.from(card.querySelectorAll('[role="button"], button, a[role="button"]'));
      for (const btn of buttons) {
        const t = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
        if (t.includes('lihat') || t.includes('joined') || t.includes('terkirim') ||
            t.includes('request sent') || t.includes('pending')) {
          return { changed: true,
                   pendingApproval: t.includes('terkirim') || t.includes('request') || t.includes('pending') };
        }
      }
      // Fallback: teks kartu sudah tidak memuat "gabung" lagi
      return { changed: !/gabung\b|join group/.test(cardText) };
    }, groupId);

    return {
      success: verify.changed,
      groupId,
      alreadyJoined: false,
      pendingApproval: verify.pendingApproval || false,
      answeredQuestions: dialogResult?.answered || false,
      unconfirmed: !verify.changed,
      error: verify.changed ? null : 'Tombol tidak berubah setelah diklik'
    };

  } catch (e) {
    return { success: false, groupId, error: e.message };
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

      // Extract member count (raw text saja — parsing di sisi Node)
      const bodyText = document.body.textContent || '';
      const memberMatch = bodyText.match(/([\d.,]+\s*(?:rb|jt|ribu|juta|[KkMm])?)\s*(anggota|members)/i);
      if (memberMatch) {
        result.memberCount = memberMatch[0];
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
      member_count_raw: details.memberCount ? parseMemberCount(details.memberCount) : null,
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

  // Filtered search for auto-join feature
  searchGroupsFiltered,

  // Join langsung dari halaman search (tanpa buka halaman grup)
  joinGroupFromSearchPage,

  // Deteksi peringatan spam/blokir Facebook di halaman
  detectSpamOnPage,

  // Group details extraction
  extractGroupDetails,

  // Network health monitor
  NetworkHealthMonitor,

  // Utility functions
  extractGroupData,
  extractGroupsFromPage,
  smartScrollAndExtract,
  parseMemberCount,
  parsePostsPerDay,
  delay,
  getFormattedTime
};
