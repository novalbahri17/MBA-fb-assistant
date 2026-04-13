const puppeteer = require('puppeteer');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Scrape joined groups from Facebook
 * @param {Array} cookies - Facebook session cookies
 * @param {Function} onProgress - Progress callback
 * @returns {Array} Array of group objects
 */
async function scrapeJoinedGroups(cookies, onProgress = () => {}) {
    let browser, page;
    
    try {
        onProgress({ status: 'launching', message: 'Membuka browser...' });
        
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized', '--disable-notifications', '--no-sandbox']
        });
        
        page = await browser.newPage();
        await page.setCookie(...cookies);
        
        onProgress({ status: 'loading', message: 'Navigasi ke halaman grup...' });
        await page.goto('https://facebook.com/groups/?category=groups&ref=bookmarks', { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });
        
        await delay(3000);
        
        const groups = [];
        let lastHeight = 0;
        let noNewContentCount = 0;
        
        onProgress({ status: 'scanning', message: 'Memindai grup yang diikuti...' });
        
        while (noNewContentCount < 5) {
            const newGroups = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'));
                const found = [];
                links.forEach(link => {
                    const href = link.href;
                    const match = href.match(/\/groups\/([a-zA-Z0-9_.-]+)/);
                    if (match && !match[1].match(/^(feed|discover|created|your)/)) {
                        const name = link.textContent?.trim() || match[1];
                        if (name && name.length > 1 && name.length < 200) {
                            found.push({ group_id: match[1], group_name: name });
                        }
                    }
                });
                return found;
            });
            
            // Add unique groups
            const beforeCount = groups.length;
            newGroups.forEach(g => {
                if (!groups.find(existing => existing.group_id === g.group_id)) {
                    groups.push(g);
                }
            });
            
            if (groups.length > beforeCount) {
                noNewContentCount = 0;
                onProgress({ status: 'scanning', message: `Ditemukan ${groups.length} grup...` });
            } else {
                noNewContentCount++;
            }
            
            // Scroll
            await page.evaluate(() => window.scrollBy(0, 500));
            await delay(500);
            
            const newHeight = await page.evaluate(() => document.body.scrollHeight);
            if (newHeight === lastHeight) {
                noNewContentCount++;
            } else {
                lastHeight = newHeight;
                noNewContentCount = 0;
            }
        }
        
        onProgress({ status: 'done', message: `Selesai. Ditemukan ${groups.length} grup.` });
        
        await browser.close();
        
        return groups;
        
    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        onProgress({ status: 'error', message: err.message });
        return [];
    }
}

/**
 * Search groups by keyword
 * @param {Array} cookies - Facebook session cookies
 * @param {string} keyword - Search keyword
 * @param {Function} onProgress - Progress callback
 * @returns {Array} Array of group objects
 */
async function searchGroupsByKeyword(cookies, keyword, onProgress = () => {}) {
    let browser, page;
    
    try {
        onProgress({ status: 'launching', message: 'Membuka browser...' });
        
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized', '--disable-notifications', '--no-sandbox']
        });
        
        page = await browser.newPage();
        await page.setCookie(...cookies);
        
        onProgress({ status: 'searching', message: `Mencari grup: "${keyword}"...` });
        await page.goto(`https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });
        
        await delay(3000);
        
        const groups = [];
        let noNewContentCount = 0;
        
        while (noNewContentCount < 3) {
            const newGroups = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'));
                const found = [];
                links.forEach(link => {
                    const href = link.href;
                    const match = href.match(/\/groups\/([a-zA-Z0-9_.-]+)/);
                    if (match && !match[1].match(/^(feed|discover|created|your)/)) {
                        const name = link.textContent?.trim() || match[1];
                        if (name && name.length > 1) {
                            found.push({ group_id: match[1], group_name: name });
                        }
                    }
                });
                return found;
            });
            
            const beforeCount = groups.length;
            newGroups.forEach(g => {
                if (!groups.find(existing => existing.group_id === g.group_id)) {
                    groups.push(g);
                }
            });
            
            if (groups.length > beforeCount) {
                noNewContentCount = 0;
            } else {
                noNewContentCount++;
            }
            
            await page.evaluate(() => window.scrollBy(0, 400));
            await delay(400);
        }
        
        onProgress({ status: 'done', message: `Ditemukan ${groups.length} grup untuk "${keyword}"` });
        
        await browser.close();
        
        return groups;
        
    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        onProgress({ status: 'error', message: err.message });
        return [];
    }
}

/**
 * Join a Facebook group
 * @param {Array} cookies - Facebook session cookies
 * @param {string} groupId - Group ID to join
 * @returns {Object} Result object
 */
async function joinGroup(cookies, groupId) {
    let browser, page;
    
    try {
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized', '--disable-notifications', '--no-sandbox']
        });
        
        page = await browser.newPage();
        await page.setCookie(...cookies);
        
        await page.goto(`https://www.facebook.com/groups/${groupId}`, { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        });
        
        await delay(2000);
        
        // Find and click Join button
        const joined = await page.evaluate(() => {
            const buttons = document.querySelectorAll('[role="button"], button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim().toLowerCase();
                if (text === 'join' || text === 'gabung') {
                    btn.click();
                    return true;
                }
            }
            return false;
        });
        
        await delay(2000);
        
        await browser.close();
        
        return { success: joined, groupId };
        
    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return { success: false, groupId, error: err.message };
    }
}

module.exports = {
    scrapeJoinedGroups,
    searchGroupsByKeyword,
    joinGroup
};
