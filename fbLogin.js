const puppeteer = require('puppeteer');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Buka browser Facebook untuk login manual
 * Mode: Quick (ambil yang terlihat saja) atau Full (scrolling semua)
 */
async function openFacebookForLogin(mode = 'quick', onProgress = () => {}) {
    let browser, page;
    
    try {
        onProgress({ status: 'launching', message: 'Membuka browser...' });
        
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--start-maximized'
            ]
        });
        
        page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        onProgress({ status: 'navigating', message: 'Membuka Facebook...' });
        
        await page.goto('https://www.facebook.com', { 
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        // Cek apakah sudah login
        let isAlreadyLoggedIn = await page.evaluate(() => {
            return document.querySelector('[aria-label="Beranda"], [aria-label="Home"], #fbNotificationsJewel') !== null;
        });
        
        if (!isAlreadyLoggedIn) {
            onProgress({ status: 'waiting', message: 'Silakan login manual...' });
            
            let attempts = 0;
            const maxAttempts = 120;
            
            while (attempts < maxAttempts) {
                await delay(2000);
                
                isAlreadyLoggedIn = await page.evaluate(() => {
                    const hasHome = document.querySelector('[aria-label="Beranda"], [aria-label="Home"]') !== null;
                    const hasNotif = document.querySelector('#fbNotificationsJewel') !== null;
                    const hasCreate = document.querySelector('[aria-label="Buat postingan"], [aria-label="Create a post"]') !== null;
                    return hasHome || hasNotif || hasCreate;
                });
                
                if (isAlreadyLoggedIn) {
                    onProgress({ status: 'detected', message: 'Login terdeteksi!' });
                    break;
                }
                
                attempts++;
                if (attempts % 10 === 0) {
                    onProgress({ status: 'waiting', message: `Menunggu... (${attempts}/${maxAttempts})` });
                }
            }
            
            if (!isAlreadyLoggedIn) {
                await browser.close();
                throw new Error('Timeout: Login tidak terdeteksi');
            }
        } else {
            onProgress({ status: 'detected', message: 'Sudah login!' });
        }
        
        await delay(3000);
        
        // Get user info
        onProgress({ status: 'getting_info', message: 'Mengambil info akun...' });
        
        const userInfo = await page.evaluate(() => {
            let name = '';
            const match = document.cookie.match(/c_user=(\d+)/);
            const userId = match ? match[1] : '';
            
            // Coba ambil nama
            const selectors = [
                'span[data-testid="profile_name_in_feed"]',
                '[data-pagelet="LeftRail"] span',
                'a[href*="/profile.php"] span'
            ];
            
            for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (el && el.innerText && el.innerText.length < 50) {
                    name = el.innerText.trim();
                    break;
                }
            }
            
            return { name, userId };
        });
        
        onProgress({ status: 'info', message: `Akun: ${userInfo.name || 'Unknown'}` });
        
        // Get cookies
        const cookies = await page.cookies();
        const importantCookies = cookies.filter(c => 
            ['c_user', 'xs', 'fr', 'datr', 'sb'].includes(c.name)
        );
        
        // Navigate ke groups
        onProgress({ status: 'navigating_groups', message: 'Membuka grup...' });
        
        await page.goto('https://www.facebook.com/groups', { 
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        await delay(3000);
        
        // Scraping grup
        const groups = [];
        const seenGroups = new Set();
        
        if (mode === 'quick') {
            // MODE CEPAT: Ambil yang terlihat saja tanpa scrolling
            onProgress({ status: 'scraping', message: 'Mengambil grup (mode cepat)...' });
            
            const visibleGroups = await page.evaluate(() => {
                const results = [];
                const links = document.querySelectorAll('a[href*="/groups/"]');
                
                links.forEach(link => {
                    const href = link.getAttribute('href');
                    if (!href) return;
                    
                    const match = href.match(/groups\/(\d+)/);
                    if (!match) return;
                    
                    const groupId = match[1];
                    if (results.find(r => r.group_id === groupId)) return;
                    
                    let groupName = link.textContent?.trim();
                    
                    if (!groupName || groupName.length < 2) {
                        let parent = link.parentElement;
                        for (let i = 0; i < 3; i++) {
                            if (!parent) break;
                            const text = parent.innerText?.trim();
                            if (text && text.length > 2 && text.length < 100) {
                                const lines = text.split('\n').filter(l => l.trim());
                                if (lines.length > 0) {
                                    groupName = lines[0];
                                    break;
                                }
                            }
                            parent = parent.parentElement;
                        }
                    }
                    
                    if (!groupName || groupName.toLowerCase().includes('profile')) return;
                    
                    results.push({
                        group_id: groupId,
                        group_name: groupName,
                        group_url: `https://facebook.com/groups/${groupId}`,
                        is_joined: true
                    });
                });
                
                return results;
            });
            
            visibleGroups.forEach(g => {
                if (!seenGroups.has(g.group_id)) {
                    seenGroups.add(g.group_id);
                    groups.push(g);
                }
            });
            
            onProgress({ status: 'scraping', message: `Ditemukan ${groups.length} grup (mode cepat)` });
            
        } else {
            // MODE FULL: Scrolling untuk dapat semua grup
            onProgress({ status: 'scraping', message: 'Mengumpulkan semua grup (mode full)...' });
            
            let scrollAttempts = 0;
            const maxScrolls = 50;
            let noNewGroupsCount = 0;
            
            while (scrollAttempts < maxScrolls && groups.length < 500) {
                const newGroups = await page.evaluate(() => {
                    const results = [];
                    const links = document.querySelectorAll('a[href*="/groups/"]');
                    
                    links.forEach(link => {
                        const href = link.getAttribute('href');
                        if (!href) return;
                        
                        const match = href.match(/groups\/(\d+)/);
                        if (!match) return;
                        
                        const groupId = match[1];
                        if (results.find(r => r.group_id === groupId)) return;
                        
                        let groupName = link.textContent?.trim();
                        
                        if (!groupName || groupName.length < 2) {
                            let parent = link.parentElement;
                            for (let i = 0; i < 4; i++) {
                                if (!parent) break;
                                const text = parent.innerText?.trim();
                                if (text && text.length > 2 && text.length < 100) {
                                    const lines = text.split('\n').filter(l => l.trim());
                                    if (lines.length > 0) {
                                        groupName = lines[0];
                                        break;
                                    }
                                }
                                parent = parent.parentElement;
                            }
                        }
                        
                        if (!groupName || groupName.toLowerCase().includes('profile')) return;
                        
                        results.push({
                            group_id: groupId,
                            group_name: groupName,
                            group_url: `https://facebook.com/groups/${groupId}`,
                            is_joined: true
                        });
                    });
                    
                    return results;
                });
                
                let addedCount = 0;
                newGroups.forEach(g => {
                    if (!seenGroups.has(g.group_id)) {
                        seenGroups.add(g.group_id);
                        groups.push(g);
                        addedCount++;
                    }
                });
                
                onProgress({ 
                    status: 'scraping', 
                    message: `Menemukan ${groups.length} grup...`
                });
                
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await delay(2000);
                
                scrollAttempts++;
                
                if (addedCount === 0) {
                    noNewGroupsCount++;
                    if (noNewGroupsCount >= 3) break;
                } else {
                    noNewGroupsCount = 0;
                }
            }
        }
        
        await browser.close();
        
        onProgress({ 
            status: 'completed', 
            message: `Selesai! ${groups.length} grup ditemukan`,
            cookies: importantCookies,
            userId: userInfo.userId,
            name: userInfo.name,
            groups: groups
        });
        
        return {
            cookies: importantCookies,
            userId: userInfo.userId,
            name: userInfo.name,
            groups: groups
        };
        
    } catch (error) {
        if (browser) await browser.close();
        onProgress({ status: 'error', message: error.message });
        throw error;
    }
}

/**
 * Extract profil Facebook dari cookies
 * @param {Array} cookies - Array of cookie objects
 * @returns {Object} - { name, facebook_id, profile_picture, email }
 */
async function extractProfileFromCookies(cookies) {
    let browser, page;
    
    try {
        console.log('[extractProfileFromCookies] Launching browser...');
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        page = await browser.newPage();
        
        // Set cookies
        console.log('[extractProfileFromCookies] Setting', cookies.length, 'cookies...');
        await page.setCookie(...cookies);
        
        // Navigate to Facebook
        console.log('[extractProfileFromCookies] Navigating to Facebook...');
        await page.goto('https://www.facebook.com', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Extract profile info
        console.log('[extractProfileFromCookies] Extracting profile info...');
        const profileInfo = await page.evaluate(() => {
            let name = '';
            let profilePicture = '';
            
            // Try to get name from various selectors
            const nameSelectors = [
                'span[data-testid="profile_name_in_feed"]',
                '[data-pagelet="LeftRail"] a span',
                'a[href*="/profile.php"] span',
                '[aria-label="Menu Akun Anda"] span',
                'span.x1lliihq.x6ikm8r.x10wlt62'
            ];
            
            for (const selector of nameSelectors) {
                const el = document.querySelector(selector);
                if (el && el.innerText && el.innerText.length > 0 && el.innerText.length < 50) {
                    name = el.innerText.trim();
                    break;
                }
            }
            
            // Try to get profile picture
            const imgEl = document.querySelector('[data-pagelet="LeftRail"] img');
            if (imgEl) {
                profilePicture = imgEl.src || '';
            }
            
            return { name, profilePicture };
        });
        
        // Get facebook_id from c_user cookie
        const cUserCookie = cookies.find(c => c.name === 'c_user');
        const facebookId = cUserCookie ? cUserCookie.value : '';
        
        console.log('[extractProfileFromCookies] Profile extracted:', { name: profileInfo.name, facebookId });
        await browser.close();
        
        return {
            name: profileInfo.name || 'Unknown',
            facebook_id: facebookId,
            profile_picture: profileInfo.profilePicture || '',
            email: null
        };
        
    } catch (error) {
        console.error('[extractProfileFromCookies] Error:', error.message);
        if (browser) await browser.close();
        throw error;
    }
}

module.exports = {
    openFacebookForLogin,
    extractProfileFromCookies
};
