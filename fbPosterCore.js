const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFormattedTime() {
  return new Date().toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function getImageFilesFromFolder(folderPath = "./img") {
  try {
    const validExt = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    if (!fs.existsSync(folderPath)) return [];
    return fs.readdirSync(folderPath)
      .filter(f => validExt.includes(path.extname(f).toLowerCase()))
      .map(f => path.resolve(folderPath, f));
  } catch (e) {
    console.error(`[getImageFilesFromFolder] Error: ${e.message}`);
    return [];
  }
}

async function launchBrowserWithCookies(cookiePath, options = {}) {
  const { cookiesOverride = null } = options;
  
  // If we have cookies to apply, launch a new browser with those cookies
  // This ensures the correct account is used
  if (cookiesOverride) {
    console.log('[launchBrowserWithCookies] Cookies override provided, launching new browser');
    return launchNewBrowser(cookiePath, options);
  }
  
  // Only try to connect to existing browsers if no cookies override
  const browserURLs = ['http://localhost:9222', 'http://localhost:9223', 'http://localhost:9224'];
  for (const url of browserURLs) {
    try {
      const browser = await puppeteer.connect({ browserURL: url, defaultViewport: null });
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('facebook.com'));
      if (!page) {
        page = await browser.newPage();
        await page.goto('https://facebook.com', { waitUntil: 'networkidle2' });
      }
      return { browser, page };
    } catch (e) {}
  }
  return launchNewBrowser(cookiePath, options);
}

async function launchNewBrowser(cookiePath, options = {}) {
  const { cookiesOverride = null, ...launchOptions } = options;
  
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized', '--disable-notifications', '--no-sandbox'],
    ...launchOptions
  });

  // Get all existing pages (Chrome may have pre-created pages like "New Tab")
  const allPages = await browser.pages();

  // Use the first available page, close extras
  let page;
  if (allPages.length > 0) {
    page = allPages[0];
    for (let i = 1; i < allPages.length; i++) {
      try { await allPages[i].close(); } catch (e) {}
    }
    // Don't close about:blank page — just reuse it to avoid browser crash
  } else {
    page = await browser.newPage();
  }
  
  // Use cookiesOverride if provided (from database/account)
  if (cookiesOverride) {
    try {
      const cookies = Array.isArray(cookiesOverride) ? cookiesOverride : JSON.parse(cookiesOverride);
      await page.setCookie(...cookies);
      console.log(`[launchNewBrowser] ✅ Cookies override applied (${cookies.length} cookies)`);
    } catch (e) {
      console.error(`[launchNewBrowser] Failed to apply cookies override: ${e.message}`);
    }
  } else if (cookiePath && fs.existsSync(cookiePath)) {
    // Fallback to file-based cookies
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
      await page.setCookie(...cookies);
      console.log(`[launchNewBrowser] ✅ Cookies loaded from file: ${cookiePath}`);
    } catch (e) {
      console.error(`[launchNewBrowser] Failed to load cookies from file: ${e.message}`);
    }
  }
  
  return { browser, page };
}

// ==================== POSTING LOGIC ====================

async function openPostDialog(page) {
  console.log(`📝 [${getFormattedTime()}] Membuka dialog post...`);

  // STEP 1: Tutup semua dialog yang terbuka (notifikasi, dll)
  console.log('📝 Closing any open dialogs...');
  await page.keyboard.press('Escape');
  await delay(1000);

  // STEP 2: Cari dan klik post box
  // Coba beberapa selector yang mungkin
  const selectorsToTry = [
    // Selector utama: cari "Tulis sesuatu..." atau "What's on your mind"
    'span[data-testid]="composer-text"',
    'span:has-text("Tulis sesuatu...")',
    'span:has-text("What\'s on your mind")',
    // Fallback: cari element dengan aria-label atau role
    '[aria-label="Buat Postingan"]',
    '[data-testid="platform-toast"] ~ div [role="button"]',
    // Untuk Facebook versi baru
    'div[aria-label="Buat Postingan"]',
    'div[aria-label="Create a post"]',
    'div[aria-label="Write something"]',
  ];

  let clicked = false;
  for (const selector of selectorsToTry) {
    try {
      const exist = await page.$(selector);
      if (exist) {
        await page.click(selector, { timeout: 3000 });
        clicked = true;
        console.log(`📝 Clicked via selector: ${selector}`);
        break;
      }
    } catch (e) {
      continue;
    }
  }

  // Fallback: evaluate JS
  if (!clicked) {
    const result = await page.evaluate(() => {
      // Cara 1: Cari span dengan text "Tulis sesuatu..."
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent?.trim();
        if (text === 'Tulis sesuatu...' || text === "What's on your mind, Facebook" ||
            text?.includes('Tulis sesuatu') || text?.includes("What's on your mind")) {
          // Klik parent button
          const parent = span.closest('div[role="button"]') || span.closest('[role="button"]') || span.parentElement;
          if (parent && parent.click) {
            parent.click();
            return { success: true, method: 'span_parent' };
          }
        }
      }

      // Cara 2: Cari div dengan aria-label "Buat Postingan"
      const divs = document.querySelectorAll('div[aria-label], div[contenteditable]');
      for (const div of divs) {
        const label = div.getAttribute('aria-label') || '';
        if (label.includes('Buat') || label.includes('Create') || label.includes('Post')) {
          div.click();
          return { success: true, method: 'aria_label_div' };
        }
      }

      // Cara 3: Cari composer (contenteditable)
      const composers = document.querySelectorAll('[contenteditable="true"]');
      if (composers.length > 0) {
        composers[0].click();
        return { success: true, method: 'contenteditable_click' };
      }

      return { success: false };
    });

    if (result?.success) {
      clicked = true;
      console.log(`📝 Clicked via JS: ${result.method}`);
    }
  }

  if (!clicked) {
    // Grup seperti ini tidak punya post box di halaman utama (composer posting
    // dimatikan / grup dikunci admin). Tidak akan berubah walau dicoba lagi →
    // grup dianggap BLACKLIST dan nanti dihapus dari Manajemen Grup oleh server.
    const postBoxErr = new Error('Post box tidak ditemukan di halaman utama');
    postBoxErr.postBoxNotFound = true;
    postBoxErr.blacklistGroup = true;
    throw postBoxErr;
  }

  // STEP 3: TUNGGU dialog "Buat Postingan" terbuka
  console.log('📝 Waiting for dialog to open...');
  let dialogOpened = false;
  for (let i = 0; i < 15; i++) {
    await delay(1000);
    dialogOpened = await page.evaluate(() => {
      // Cek 1: Dialog dengan title
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const dialog of dialogs) {
        const title = dialog.querySelector('h2, h3, div[aria-label]');
        if (title) {
          const text = title.textContent || title.getAttribute('aria-label') || '';
          if (text.includes('Buat') || text.includes('Create') || text.includes('Post')) {
            return true;
          }
        }
      }
      // Cek 2: contenteditable di dalam dialog
      const ces = document.querySelectorAll('[contenteditable="true"]');
      for (const ce of ces) {
        const parent = ce.closest('[role="dialog"]');
        if (parent) return true;
      }
      // Cek 3: Ada banyak contenteditable (artinya dialog terbuka)
      return ces.length >= 2;
    });
    if (dialogOpened) {
      console.log(`📝 Dialog opened after ${i + 1} seconds`);
      break;
    }
  }

  if (!dialogOpened) {
    // Final check - kalau masih ada contenteditable berarti dialog mungkin sudah terbuka
    const hasComposer = await page.evaluate(() => {
      return document.querySelectorAll('[contenteditable="true"]').length > 0;
    });
    if (!hasComposer) {
      throw new Error('Dialog post tidak muncul setelah 15 detik');
    }
    console.log(`📝 Dialog may be open (composer found)`);
  }

  // Tunggu extra 2 detik untuk animasi
  await delay(2000);
  return true;
}

async function fillContent(page, content) {
  const clean = (content || '').trim();
  if (!clean || clean === '.') return;

  console.log(`✍️ [${getFormattedTime()}] Mengisi konten: "${clean}"`);

  // Tunggu dialog composer terbuka
  let foundDialog = false;

  for (let attempt = 0; attempt < 10; attempt++) {
    await delay(1000);
    const state = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const allCE = document.querySelectorAll('[contenteditable="true"]');

      // Log all dialogs for debugging
      const dialogInfo = Array.from(dialogs).map(d => ({
        label: d.getAttribute('aria-label'),
        ceCount: d.querySelectorAll('[contenteditable="true"]').length
      }));

      // Find a dialog that has contenteditable
      for (const dialog of dialogs) {
        const ce = dialog.querySelector('[contenteditable="true"]');
        if (ce) {
          return {
            found: true,
            dialogLabel: dialog.getAttribute('aria-label'),
            ceCount: dialog.querySelectorAll('[contenteditable="true"]').length,
            allDialogs: dialogInfo
          };
        }
      }

      // Fallback: if no dialog has contenteditable, check if there are multiple CEs
      // That might mean a dialog is open
      if (allCE.length >= 2) {
        return {
          found: true,
          dialogLabel: 'multiple_ce_detected',
          ceCount: allCE.length,
          allDialogs: dialogInfo
        };
      }

      return { found: false, allDialogs: dialogInfo };
    });
    console.log(`📝 Wait attempt ${attempt}:`, JSON.stringify(state));

    if (state.found) {
      foundDialog = true;
      break;
    }
  }

  if (!foundDialog) {
    throw new Error('Composer tidak ditemukan setelah 10 percobaan');
  }

  // FILL via evaluate - stay within the SAME create dialog
  const filled = await page.evaluate(async (text) => {
    // Find the dialog that has contenteditable
    const dialogs = document.querySelectorAll('[role="dialog"]');
    let targetDialog = null;
    let ce = null;

    // Find ANY dialog with contenteditable
    for (const dialog of dialogs) {
      const ceElement = dialog.querySelector('[contenteditable="true"]');
      if (ceElement) {
        targetDialog = dialog;
        ce = ceElement;
        // Store reference to window for uploadImage to use
        window.__fbCurrentDialog = dialog;
        window.__fbCurrentDialogCE = ce;
        console.log('[FILL] Found dialog with CE, label:', dialog.getAttribute('aria-label'));
        break;
      }
    }

    if (!targetDialog || !ce) {
      console.log('[FILL] Create dialog not found!');
      return false;
    }

    // Click to focus - multiple times for reliability
    ce.focus();
    await new Promise(r => setTimeout(r, 200));

    // Triple click to select all
    ce.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3 }));
    await new Promise(r => setTimeout(r, 150));

    // Clear content completely
    document.execCommand('selectAll', false, null);
    await new Promise(r => setTimeout(r, 50));

    // Clear via backspace
    ce.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    await new Promise(r => setTimeout(r, 50));

    // Double check cleared
    if (ce.innerText || ce.textContent) {
      ce.innerText = '';
      ce.textContent = '';
      await new Promise(r => setTimeout(r, 100));
    }

    // Now type using keyboard simulation - most reliable for React
    ce.focus();
    await new Promise(r => setTimeout(r, 100));

    // Type character by character to trigger React properly
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      ce.dispatchEvent(new KeyboardEvent('keydown', {
        key: char,
        char: char,
        code: 'Digit' + (i % 10),
        bubbles: true
      }));
      ce.innerText += char;
      ce.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: char
      }));
    }

    // Final verification
    await new Promise(r => setTimeout(r, 300));
    const finalText = ce.innerText || ce.textContent || '';
    console.log('[FILL] Final text:', JSON.stringify(finalText));

    // Success if content matches (case sensitive)
    return finalText === text;
  }, clean);

  if (!filled) {
    console.warn(`⚠️ Warning: konten mungkin tidak terisi dengan benar`);
  }

  await delay(2000);
  console.log(`✅ Konten diisi`);
}

async function uploadImage(page, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) {
    console.log(`🖼️ No images to upload`);
    return;
  }

  console.log(`🖼️ [${getFormattedTime()}] Mengupload ${imagePaths.length} gambar...`);

  // Convert paths to absolute paths
  const absolutePaths = imagePaths.map(p => {
    const normalizedPath = p.startsWith('/') ? p.substring(1) : p;
    const projectRoot = path.resolve(__dirname);
    if (normalizedPath.startsWith('uploads/') || p.startsWith('/uploads/')) {
      return path.join(projectRoot, 'web-dashboard', 'uploads', path.basename(normalizedPath));
    }
    if (normalizedPath.startsWith('img/') || p.startsWith('/img/')) {
      return path.join(projectRoot, 'img', path.basename(normalizedPath));
    }
    return path.resolve(p);
  });

  console.log(`📎 Absolute paths:`, absolutePaths);

  // Verify files exist
  for (const p of absolutePaths) {
    if (!fs.existsSync(p)) {
      console.error(`⚠️ File tidak ditemukan: ${p}`);
      throw new Error(`File tidak ditemukan: ${p}`);
    }
    console.log(`   ✅ File exists: ${p}`);
  }

  // STRATEGY: Find and identify the EXACT composer file input BEFORE clicking photo
  // We need to find the form that contains contenteditable="true" and get its file input
  // Then click photo, then upload to THAT SAME file input we identified

  console.log(`📎 Step 1: Identifying composer file input...`);

  const composerInfo = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');

    for (const dialog of dialogs) {
      const ce = dialog.querySelector('[contenteditable="true"]');
      if (!ce) continue;

      // Find the form that contains this contenteditable
      let composerForm = ce.closest('form');

      // If not found by closest, walk up manually
      if (!composerForm) {
        let parent = ce.parentElement;
        while (parent && parent.tagName !== 'BODY') {
          if (parent.tagName === 'FORM') {
            composerForm = parent;
            break;
          }
          parent = parent.parentElement;
        }
      }

      if (composerForm) {
        const fileInput = composerForm.querySelector('input[type="file"]');
        if (fileInput) {
          // Get unique identifier for this file input
          const inputs = composerForm.querySelectorAll('input[type="file"]');
          const fileInputIndex = Array.from(inputs).indexOf(fileInput);

          return {
            found: true,
            formClass: composerForm.className.substring(0, 50),
            formAction: composerForm.action,
            fileInputIndex: fileInputIndex,
            totalFormsOnPage: document.querySelectorAll('form').length,
            totalInputsInForm: inputs.length
          };
        }
      }
    }

    return { found: false };
  });

  console.log(`📎 Composer info:`, JSON.stringify(composerInfo));

  if (!composerInfo.found) {
    throw new Error('Cannot find composer form with file input');
  }

  // Step 2: Click photo button in composer (to activate the input)
  console.log(`📎 Step 2: Clicking photo button...`);

  const photoClicked = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const dialog of dialogs) {
      const ce = dialog.querySelector('[contenteditable="true"]');
      if (!ce) continue;

      const allEls = dialog.querySelectorAll('*');
      for (const el of allEls) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        if (al.includes('foto') || al.includes('photo') || al.includes('kamera') || al.includes('camera')) {
          if (typeof el.click === 'function') {
            el.click();
            return { success: true, label: al };
          }
        }
      }
    }
    return { success: false };
  });

  console.log(`📎 Photo clicked:`, JSON.stringify(photoClicked));

  if (!photoClicked.success) {
    throw new Error('Photo button not found in composer');
  }

  // Step 3: Wait for picker to initialize, then upload to the specific file input
  await delay(2000);

  console.log(`📎 Step 3: Uploading to identified composer file input...`);

  // Use page.evaluate to upload to the SPECIFIC file input we identified
  // We identify it by: form contains contenteditable AND file input is at the specific index
  const uploadResult = await page.evaluate(async (absPath) => {
    const fs = require('fs');
    const pathModule = require('path');

    const dialogs = document.querySelectorAll('[role="dialog"]');

    for (const dialog of dialogs) {
      const ce = dialog.querySelector('[contenteditable="true"]');
      if (!ce) continue;

      let composerForm = ce.closest('form');
      if (!composerForm) {
        let parent = ce.parentElement;
        while (parent && parent.tagName !== 'BODY') {
          if (parent.tagName === 'FORM') {
            composerForm = parent;
            break;
          }
          parent = parent.parentElement;
        }
      }

      if (composerForm) {
        const fileInput = composerForm.querySelector('input[type="file"]');
        if (fileInput) {
          try {
            // Read the file
            const fileBuffer = fs.readFileSync(absPath);
            const blob = new Blob([fileBuffer]);
            const fileObj = new File([blob], pathModule.basename(absPath), { type: 'image/png' });

            // Use DataTransfer to set files
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(fileObj);

            Object.defineProperty(fileInput, 'files', {
              value: dataTransfer.files,
              writable: true,
              configurable: true
            });

            // Fire change event
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));

            console.log('[UPLOAD] File set via DataTransfer, dispatched change event');
            return { success: true, method: 'datatransfer' };
          } catch (e) {
            return { success: false, error: e.message };
          }
        }
      }
    }

    return { success: false, error: 'Composer form or file input not found' };
  }, absolutePaths[0]);

  console.log(`📎 Upload result:`, JSON.stringify(uploadResult));

  if (!uploadResult.success) {
    throw new Error('Failed to upload: ' + uploadResult.error);
  }

  await delay(12000);
  console.log(`🖼️ Upload complete`);
}

async function clickPostButton(page) {
  console.log(`📤 [${getFormattedTime()}] Klik tombol Posting...`);
  await delay(3000);

  // Find the composer dialog (has contenteditable)
  const composerInfo = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    let composerDialog = null;

    for (const dialog of dialogs) {
      if (dialog.querySelector('[contenteditable="true"]')) {
        composerDialog = dialog;
        break;
      }
    }

    if (!composerDialog) {
      return { found: false };
    }

    // Now find the Posting button INSIDE this composer dialog ONLY
    const buttons = composerDialog.querySelectorAll('button, [role="button"], input[type="submit"]');
    const postingButtons = [];

    for (const btn of buttons) {
      const text = (btn.innerText || btn.value || '').toLowerCase().trim();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const type = (btn.getAttribute('type') || '').toLowerCase();

      if ((text === 'posting' || text === 'post' || ariaLabel === 'posting') &&
          !text.includes('batal') && !text.includes('cancel') &&
          !ariaLabel.includes('batal') && !ariaLabel.includes('cancel')) {
        postingButtons.push({
          text: text || ariaLabel,
          ariaLabel,
          type,
          disabled: btn.disabled
        });
      }
    }

    return {
      found: true,
      dialogLabel: composerDialog.getAttribute('aria-label'),
      postingButtons
    };
  });

  console.log(`📤 Composer info:`, JSON.stringify(composerInfo, null, 2));

  if (!composerInfo.found) {
    throw new Error('Composer dialog tidak ditemukan');
  }

  if (composerInfo.postingButtons.length === 0) {
    throw new Error('Tombol Posting tidak ditemukan di composer dialog');
  }

  // Click the first valid posting button
  const clicked = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');

    for (const dialog of dialogs) {
      if (!dialog.querySelector('[contenteditable="true"]')) continue;

      const buttons = dialog.querySelectorAll('button, [role="button"]');

      for (const btn of buttons) {
        const text = (btn.innerText || btn.value || '').toLowerCase().trim();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

        if ((text === 'posting' || text === 'post' || ariaLabel === 'posting') &&
            !text.includes('batal') && !text.includes('cancel') &&
            !ariaLabel.includes('batal') && !ariaLabel.includes('cancel')) {
          btn.click();
          return { success: true, buttonText: text || ariaLabel };
        }
      }
    }

    return { success: false, error: 'Button not found in composer' };
  });

  console.log('📤 Click result:', clicked);

  if (clicked.success) {
    console.log(`✅ Tombol Posting diklik!`);
    await delay(8000);
    return true;
  }

  throw new Error('Tombol Post tidak ditemukan di composer dialog');
}

async function scanMyJoinedGroups(page, options = {}) {
  const { maxScrolls = 50, onProgress } = options;
  let groups = [];
  
  console.log(`🔍 [${getFormattedTime()}] Scanning joined groups...`);
  
  try {
    // 1. Go to the "Groups you've joined" page
    // This page is much cleaner than the feed
    await page.goto('https://facebook.com/groups/?category=groups&ref=bookmarks', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1000);
    
    // 2. Extract initial batch
    let batch = await extractGroupsFromPage(page);
    groups = [...new Set([...groups, ...batch])]; // Unique
    if (onProgress) onProgress({ count: groups.length, phase: 'initial' });
    
    // 3. Scroll and extract
    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await delay(400); // Fast delay - adjust if network is slow
      
      batch = await extractGroupsFromPage(page);
      const prevCount = groups.length;
      groups = [...new Set([...groups, ...batch])];
      
      if (onProgress) onProgress({ count: groups.length, phase: 'scrolling' });
      
      // If no new groups added after 2 scrolls, we probably hit the bottom
      if (i > 2 && groups.length === prevCount) {
        console.log(`ℹ️ [${getFormattedTime()}] No new groups found after scrolling, stopping.`);
        break;
      }
    }
    
    console.log(`✅ [${getFormattedTime()}] Scan complete. Found ${groups.length} groups.`);
    return groups;
    
  } catch (err) {
    console.error(`❌ [${getFormattedTime()}] Scan error: ${err.message}`);
    // Return what we have so far
    return groups;
  }
}

// Helper to extract group IDs/links efficiently
async function extractGroupsFromPage(page) {
  return await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'));
    const groups = new Set();
    
    links.forEach(link => {
      const href = link.href;
      // Extract ID or slug from URL
      // Patterns: /groups/123456789/, /groups/my-group-name/
      const match = href.match(/\/groups\/([a-zA-Z0-9_.-]+)/);
      if (match) {
        const id = match[1];
        // Filter out non-group links like /groups/feed, /groups/discover, etc.
        if (!id.startsWith('feed') && !id.startsWith('discover') && !id.startsWith('created') && !id.startsWith('your')) {
          groups.add(id);
        }
      }
    });
    
    return Array.from(groups);
  });
}

async function postToGroup(page, groupId, postContent, imagePaths = [], options = {}) {
  const { onProgress, maxRetries = 3, retryDelay = 5000 } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (onProgress) onProgress({ status: 'navigating', attempt });
      console.log(`\n🌐 [${getFormattedTime()}] GRUP: ${groupId} (Attempt ${attempt}/${maxRetries})`);

      // Navigasi ke grup
      await page.goto(`https://facebook.com/groups/${groupId}`, { waitUntil: "networkidle2", timeout: 60000 });
      await delay(6000);

      // Cek apakah terdeteksi spam/blocked — hanya cek notifikasi yang spesifik untuk akun
      const spamDetected = await page.evaluate(() => {
        const text = document.body.innerText;
        // Harus spesifik — bukan sekadar kata "spam" yang bisa muncul di konten grup
        return (
          text.includes('tidak bisa memposting') ||
          text.includes('sementara diblokir') ||
          text.includes('Akun Anda telah dinonaktifkan') ||
          text.includes('Your account has been disabled') ||
          text.includes('You\'re Temporarily Blocked') ||
          text.includes('Anda sementara diblokir') ||
          text.includes('Anda telah diblokir') ||
          text.includes('You\'ve been blocked') ||
          text.includes('We have limits to prevent misuse') ||
          text.includes('unusual activity from your account') ||
          text.includes('aktivitas tidak biasa dari akun Anda')
        );
      });
      if (spamDetected) {
        return { success: false, groupId, spamDetected: true, error: 'Akun terdeteksi spam/blocked' };
      }

      // Cek apakah SESI LOGIN EXPIRED — cookies habis / logout / checkpoint login.
      // Ini WAJIB dicek lebih dulu supaya pengguna langsung tahu harus login ulang,
      // dan supaya tidak menganggap kegagalan sebagai "sukses".
      const sessionInvalid = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const url = location.href;
        return (
          url.includes('/login') ||
          url.includes('login.php') ||
          url.includes('/checkpoint') ||
          url.includes('/recover') ||
          text.includes('Login Facebook') ||
          text.includes('Log in to Facebook') ||
          text.includes('Log Into Facebook') ||
          text.includes('Anda harus login') ||
          text.includes('You must log in') ||
          text.includes('Sesi Anda telah berakhir') ||
          text.includes('Session Expired') ||
          text.includes('Masuk ke Facebook') ||
          text.includes('Email atau Nomor Telepon') ||
          text.includes('Email or Phone') ||
          text.includes('Kata Sandi') ||
          text.includes('Kata sandi') ||
          text.includes('Forgot password') ||
          text.includes('Lupa kata sandi')
        );
      });
      if (sessionInvalid) {
        console.log(`🔐 [${getFormattedTime()}] SESI EXPIRED / LOGIN DIPERLUKAN untuk grup ${groupId}`);
        return {
          success: false,
          groupId,
          sessionInvalid: true,
          error: 'Sesi login/cookies tidak valid (expired atau logout). Perbarui cookies akun lalu coba lagi.'
        };
      }

      // Cek apakah grup dinonaktifkan — hanya berdasarkan teks eksplisit dari FB
      const pageUrl = page.url();
      const isGroupDisabled = await page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes('postingan dinonaktifkan') ||
          text.includes('posting dinonaktifkan') ||
          text.includes('diskusi dinonaktifkan') ||
          text.includes('turned off posting') ||
          text.includes('posting is turned off') ||
          text.includes('posts are turned off') ||
          text.includes('This group no longer exists') ||
          text.includes('Grup ini sudah tidak ada')
        );
      });

      // Cek redirect — jika URL bukan grup yang dituju sama sekali
      const redirectedAway = !pageUrl.includes('/groups/');

      if (isGroupDisabled || redirectedAway) {
        const reason = redirectedAway
          ? `Grup redirect/tidak ditemukan (URL: ${pageUrl})`
          : 'Grup menonaktifkan posting/diskusi';
        console.log(`🚫 [${getFormattedTime()}] SKIP grup ${groupId}: ${reason}`);
        return { success: false, groupId, groupDisabled: true, error: reason };
      }

      // Buka dialog post
      if (onProgress) onProgress({ status: 'opening_postbox', attempt });
      await openPostDialog(page);
      await delay(2000); // Extra wait untuk dialog stabil

      // Catat apakah composer benar-benar terbuka (ada [role="dialog"] dengan contenteditable).
      // Dipakai untuk memastikan "dialog menutup" hanya dianggap sukses jika dialog sempat terbuka.
      const composerOpened = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          if (d.querySelector('[contenteditable="true"]')) return true;
        }
        return false;
      });
      console.log(`📝 Composer opened: ${composerOpened}`);

      // Siapkan image paths
      const absolutePaths = (imagePaths || []).map(p => {
        const normalizedPath = p.startsWith('/') ? p.substring(1) : p;
        const projectRoot = path.resolve(__dirname);
        if (normalizedPath.startsWith('uploads/') || p.startsWith('/uploads/')) {
          return path.join(projectRoot, 'web-dashboard', 'uploads', path.basename(normalizedPath));
        }
        if (normalizedPath.startsWith('img/') || p.startsWith('/img/')) {
          return path.join(projectRoot, 'img', path.basename(normalizedPath));
        }
        return path.resolve(p);
      });

      const hasImages = absolutePaths.length > 0;
      const cleanContent = (postContent || '').trim();

      // STEP: Fill text using keyboard typing (this works reliably with React)
      if (onProgress) onProgress({ status: 'typing', attempt });
      if (cleanContent) {
        // Focus the contenteditable first
        await page.evaluate(() => {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const ce = dialog.querySelector('[contenteditable="true"]');
            if (ce) {
              ce.focus();
              return;
            }
          }
        });
        await delay(500);
        await page.keyboard.type(cleanContent, { delay: 50 });
        console.log(`✍️ Typed text: "${cleanContent}"`);
      }

      await delay(1000);

      // STEP 2: Upload image ke composer dialog — tanpa membuka OS file dialog
      if (hasImages) {
        if (onProgress) onProgress({ status: 'uploading', attempt });

        console.log(`📎 Uploading images to composer dialog...`);
        try {
          let uploaded = false;

          // STEP 0: Find and STORE the reference to the ACTIVE composer dialog
          // Store it in window so all subsequent operations use the SAME dialog
          const activeDialogRef = await page.evaluate(() => {
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (const dialog of dialogs) {
              const ce = dialog.querySelector('[contenteditable="true"]');
              if (ce) {
                // Check this dialog has buttons (is a real composer, not just a comment box)
                const buttons = dialog.querySelectorAll('button, [role="button"]');
                const hasPostButton = Array.from(buttons).some(b => {
                  const text = (b.innerText || '').toLowerCase();
                  const al = (b.getAttribute('aria-label') || '').toLowerCase();
                  return text.includes('posting') || text.includes('post') || al.includes('posting');
                });
                if (hasPostButton) {
                  // Store the dialog's unique identifier
                  window.__fbActiveComposerDialog = dialog;
                  window.__fbActiveComposerHasPhotoBtn = true;
                  // Find photo button and store it
                  for (const el of dialog.querySelectorAll('[role="button"], button')) {
                    const al = (el.getAttribute('aria-label') || '').toLowerCase();
                    if (al.includes('foto') || al.includes('photo') || al.includes('kamera') || al.includes('camera') || al.includes('gambar') || al.includes('video')) {
                      window.__fbActivePhotoBtn = el;
                      window.__fbActivePhotoBtnLabel = al;
                      return { found: true, photoLabel: al };
                    }
                  }
                  return { found: true, noPhotoBtn: true };
                }
              }
            }
            return { found: false };
          });
          console.log(`📎 Active composer detected:`, JSON.stringify(activeDialogRef));

          // APPROACH 1: Upload langsung ke hidden file input tanpa klik tombol sama sekali
          // (tidak membuka OS file dialog)
          const markedDirect = await page.evaluate(() => {
            document.querySelectorAll('[data-fb-composer-upload]').forEach(el => el.removeAttribute('data-fb-composer-upload'));
            // Use the stored active dialog reference
            const dialog = window.__fbActiveComposerDialog;
            if (!dialog) return 0;
            let count = 0;
            dialog.querySelectorAll('input[type="file"]').forEach(input => {
              input.setAttribute('data-fb-composer-upload', 'true');
              count++;
            });
            return count;
          });
          console.log(`📎 Direct hidden file inputs in composer: ${markedDirect}`);

          if (markedDirect > 0) {
            const directHandle = await page.$('[data-fb-composer-upload="true"]');
            if (directHandle) {
              await directHandle.uploadFile(...absolutePaths);
              console.log(`✅ Upload berhasil via direct hidden file input (tanpa OS dialog)`);
              await delay(12000);
              uploaded = true;
            }
          }

          if (!uploaded) {
            // APPROACH 2: Klik tombol Foto tapi INTERCEPT file chooser sebelum OS dialog muncul
            console.log(`📎 Mendaftarkan file chooser interceptor sebelum klik tombol foto...`);

            const chooserPromise = new Promise((resolve) => {
              const timeoutId = setTimeout(() => resolve({ handled: false, reason: 'timeout' }), 7000);
              page.once('filechooser', async (chooser) => {
                clearTimeout(timeoutId);
                try {
                  await chooser.accept(absolutePaths);
                  console.log(`✅ File chooser diintersep — OS dialog tidak ditampilkan`);
                  resolve({ handled: true });
                } catch (err) {
                  resolve({ handled: false, reason: err.message });
                }
              });
            });

            // Klik tombol Foto di composer dialog - USE STORED REFERENCE
            await page.evaluate(() => {
              // First try stored active photo button
              if (window.__fbActivePhotoBtn) {
                window.__fbActivePhotoBtn.click();
                return;
              }
              // Fallback: use stored dialog
              const dialog = window.__fbActiveComposerDialog;
              if (!dialog) return;
              const allEls = dialog.querySelectorAll('[role="button"], button, [aria-label]');
              for (const el of allEls) {
                const al = (el.getAttribute('aria-label') || '').toLowerCase();
                if (al.includes('foto') || al.includes('photo') || al.includes('gambar') ||
                    al.includes('video') || al.includes('camera') || al.includes('kamera')) {
                  el.click();
                  return;
                }
              }
            });

            const chooserResult = await chooserPromise;
            console.log(`📎 Chooser intercept result:`, chooserResult);

            if (chooserResult.handled) {
              await delay(12000);
              uploaded = true;
            } else {
              // FB buka inline upload UI (bukan OS dialog) — cari file input baru di composer
              await delay(2500);
              const markedAfterClick = await page.evaluate(() => {
                document.querySelectorAll('[data-fb-composer-upload]').forEach(el => el.removeAttribute('data-fb-composer-upload'));
                const dialogs = document.querySelectorAll('[role="dialog"]');
                let count = 0;
                for (const dialog of dialogs) {
                  const ce = dialog.querySelector('[contenteditable="true"]');
                  if (!ce) continue;
                  dialog.querySelectorAll('input[type="file"]').forEach(input => {
                    input.setAttribute('data-fb-composer-upload', 'true');
                    count++;
                  });
                  if (count > 0) break;
                }
                return count;
              });
              console.log(`📎 File inputs setelah klik tombol: ${markedAfterClick}`);

              if (markedAfterClick > 0) {
                const handle = await page.$('[data-fb-composer-upload="true"]');
                if (handle) {
                  await handle.uploadFile(...absolutePaths);
                  console.log(`✅ Upload via post-click composer file input`);
                  await delay(12000);
                  uploaded = true;
                }
              } else {
                // Last resort: Use stored dialog reference to find file input
                const lastResortSuccess = await page.evaluate(async (paths) => {
                  const dialog = window.__fbActiveComposerDialog;
                  if (!dialog) return false;
                  
                  // Find file input within the stored dialog
                  const fileInput = dialog.querySelector('input[type="file"]');
                  if (!fileInput) return false;
                  
                  try {
                    // Try to upload using the file input
                    // Note: Puppeteer can't directly set files via evaluate in newer Chrome
                    // But we can trigger the change event with DataTransfer
                    const fs = require('fs');
                    const pathModule = require('path');
                    
                    const fileBuffer = fs.readFileSync(paths[0]);
                    const blob = new Blob([fileBuffer]);
                    const fileObj = new File([blob], pathModule.basename(paths[0]), { type: 'image/png' });
                    
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(fileObj);
                    
                    Object.defineProperty(fileInput, 'files', {
                      value: dataTransfer.files,
                      writable: true,
                      configurable: true
                    });
                    
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log('[LAST-RESORT] File uploaded via DataTransfer');
                    return true;
                  } catch (e) {
                    console.log('[LAST-RESORT] Error:', e.message);
                    return false;
                  }
                }, absolutePaths);
                
                if (lastResortSuccess) {
                  await delay(12000);
                  uploaded = true;
                }
              }
            }
          }

          if (!uploaded) {
            console.log(`⚠️ Tidak dapat upload gambar — semua pendekatan gagal`);
          }
        } catch (e) {
          console.log(`📎 Upload error: ${e.message}`);
        }
      }

      await delay(2000);

      // STEP: Click Post button
      if (onProgress) onProgress({ status: 'submitting', attempt });
      console.log(`📤 Clicking Post button...`);
      await clickPostButton(page);

      // Tunggu dan cek apakah posting berhasil
      console.log(`⏳ Waiting for post confirmation...`);
      await delay(8000);

      // Cek berbagai indikator sukses
      const postResult = await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase(); // lowercase for case-insensitive check

        // Indikator 1: Pesan "Terima kasih atas postingan Anda"
        const hasThankYou = bodyText.includes('terima kasih') ||
                           bodyText.includes('terkirim') ||
                           bodyText.includes('your post is go');

        // Indikator 2: "Menunggu persetujuan"
        const hasPendingApproval = bodyText.includes('menunggu') ||
                                   bodyText.includes('pending') ||
                                   bodyText.includes('awaiting');

        // Indikator 3: Dialog sukses muncul
        const dialogs = document.querySelectorAll('[role="dialog"]');
        let dialogText = '';
        for (const dialog of dialogs) {
          dialogText += dialog.innerText + ' ';
        }
        const dialogHasSuccess = dialogText.includes('Terima kasih') ||
                                 dialogText.includes('Menunggu') ||
                                 dialogText.includes('persetujuan') ||
                                 dialogText.includes('thank');

        // Indikator 4: Post box hilang (berarti post sudah dikirim)
        const allCE = document.querySelectorAll('[contenteditable="true"]');
        // Hitung berapa contenteditable - kalau lebih sedikit berarti dialog close
        const postBoxVisible = allCE.length >= 2; // Masih ada dialog (>=2 karena ada form+inline)

        // Indikator 5: Cek apakah dialog "Buat Postingan" masih terbuka
        let createPostDialogOpen = false;
        for (const dialog of dialogs) {
          const title = dialog.querySelector('h2, h3, [aria-label]');
          if (title) {
            const text = title.textContent || title.getAttribute('aria-label') || '';
            if (text.includes('Buat') || text.includes('Create')) {
              createPostDialogOpen = true;
            }
          }
        }

        return {
          hasThankYou,
          hasPendingApproval,
          dialogHasSuccess,
          postBoxVisible,
          createPostDialogOpen,
          networkError: bodyText.includes('network request timed out') ||
                        bodyText.includes('composerstorycreatemutation') ||
                        bodyText.includes('network error'),
          totalCE: allCE.length,
          dialogCount: dialogs.length,
          bodyTextPreview: bodyText.substring(0, 300)
        };
      });

      console.log(`📝 Post result:`, JSON.stringify(postResult, null, 2));

      // Deteksi gangguan jaringan / server composer Facebook gagal memproses post.
      // Kondisi ini BUKAN spam, tapi butuh jeda panjang (auto-pause 1 jam) lalu dicoba ulang.
      if (!postResult.hasThankYou && !postResult.dialogHasSuccess && postResult.networkError) {
        const netError = new Error(
          'Network request timed out. ComposerStoryCreateMutation — composer gagal memproses postingan.'
        );
        netError.networkTimeout = true;
        throw netError;
      }

      // Success criteria:
      // - Ada indikator sukses eksplisit (thank you / pending approval), ATAU
      // - Composer SEMPAT terbuka lalu tertutup (tanda post terkirim).
      // PENTING: jangan anggap sukses hanya karena dialog "tidak terbuka" —
      // kalau composer memang gagal dibuka (mis. sesi invalid), itu kegagalan.
      const success = postResult.hasThankYou || postResult.hasPendingApproval ||
                      postResult.dialogHasSuccess ||
                      (composerOpened && !postResult.createPostDialogOpen);

      if (success) {
        console.log(`✅ [${getFormattedTime()}] Berhasil posting ke grup ${groupId}`);
        return {
          success: true,
          groupId,
          pendingApproval: postResult.hasPendingApproval || postResult.dialogHasSuccess,
          attempts: attempt
        };
      }

      console.log(`⚠️ Posting belum terkonfirmasi (composerOpened=${composerOpened})...`);
      if (!composerOpened) {
        // Composer tidak pernah terbuka → kemungkinan sesi/login bermasalah
        return {
          success: false,
          groupId,
          sessionInvalid: true,
          error: 'Composer tidak dapat dibuka — kemungkinan sesi login/cookies tidak valid.'
        };
      }
      throw new Error('Posting tidak terkonfirmasi - dialog masih terbuka');

    } catch (error) {
      lastError = error;
      console.log(`❌ [${getFormattedTime()}] Attempt ${attempt} gagal: ${error.message}`);

      // Grup tanpa post box (blacklist) — percuma retry, langsung laporkan ke server.
      if (error.blacklistGroup || isPostBoxNotFoundMessage(error.message)) {
        console.log(`🚫 Grup ${groupId} blacklist (post box tidak ada) — grup akan dihapus dari Manajemen Grup.`);
        return {
          success: false,
          groupId,
          blacklist: true,
          postBoxNotFound: true,
          error: error.message,
          attempts: attempt
        };
      }

      // Network timeout / composer error tidak akan sembuh dengan retry cepat (5 detik).
      // Langsung kembalikan flag networkTimeout ke server agar diputuskan auto-pause 1 jam.
      if (isNetworkTimeoutMessage(error.message)) {
        console.log(`🌐 Network/composer error terdeteksi — berhenti retry cepat, menunggu auto-pause.`);
        return {
          success: false,
          groupId,
          networkTimeout: true,
          error: error.message,
          attempts: attempt
        };
      }

      if (attempt < maxRetries) {
        console.log(`⏳ Retry dalam ${retryDelay/1000} detik...`);
        await delay(retryDelay);
      }
    }
  }

  console.log(`❌ [${getFormattedTime()}] FINAL FAIL untuk grup ${groupId}`);
  const finalNetworkTimeout = isNetworkTimeoutMessage(lastError?.message);
  const finalBlacklist = isPostBoxNotFoundMessage(lastError?.message);
  return {
    success: false,
    groupId,
    error: lastError?.message,
    attempts: maxRetries,
    ...(finalNetworkTimeout ? { networkTimeout: true } : {}),
    ...(finalBlacklist ? { blacklist: true, postBoxNotFound: true } : {})
  };
}

/**
 * Cek apakah pesan error menandakan grup blacklist:
 * tidak ada post box di halaman utama grup (composer dimatikan / grup dikunci).
 */
function isPostBoxNotFoundMessage(message) {
  if (!message) return false;
  return String(message).toLowerCase().includes('post box tidak ditemukan');
}

/**
 * Cek apakah pesan error menandakan gangguan jaringan / composer Facebook gagal.
 * Contoh: "Network request timed out. ComposerStoryCreateMutation(29230635736522902)"
 */
function isNetworkTimeoutMessage(message) {
  if (!message) return false;
  const msg = String(message).toLowerCase();
  return (
    msg.includes('network request timed out') ||
    msg.includes('composerstorycreatemutation') ||
    msg.includes('net::err_') ||
    msg.includes('timeouterror') ||
    msg.includes('navigation timeout') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('target closed') ||
    msg.includes('protocol error')
  );
}

/**
 * Join a Facebook group on an existing page (reuses browser session)
 * @param {Page} page - Puppeteer page object
 * @param {string} groupId - Group ID to join
 * @param {Object} options - Options
 * @param {Function} [options.onProgress] - Progress callback
 * @param {number} [options.maxRetries=3] - Max retry attempts
 * @param {number} [options.retryDelay=5000] - Delay between retries in ms
 * @returns {Promise<Object>} Result: { success, groupId, alreadyJoined, pendingApproval, error, attempts }
 */
async function joinGroupOnPage(page, groupId, options = {}) {
  const { onProgress, maxRetries = 3, retryDelay = 5000 } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (onProgress) onProgress({ status: 'navigating', attempt });
      console.log(`\n🔗 [${getFormattedTime()}] JOIN GRUP: ${groupId} (Attempt ${attempt}/${maxRetries})`);

      // Navigate to group page
      await page.goto(`https://facebook.com/groups/${groupId}`, { waitUntil: "networkidle2", timeout: 60000 });
      await delay(4000);

      // Check spam/blocked
      const spamDetected = await page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes('tidak bisa memposting') ||
          text.includes('sementara diblokir') ||
          text.includes('Akun Anda telah dinonaktifkan') ||
          text.includes('Your account has been disabled') ||
          text.includes("You're Temporarily Blocked") ||
          text.includes('Anda sementara diblokir') ||
          text.includes('Anda telah diblokir') ||
          text.includes("You've been blocked") ||
          text.includes('We have limits to prevent misuse') ||
          text.includes('unusual activity from your account') ||
          text.includes('aktivitas tidak biasa dari akun Anda')
        );
      });
      if (spamDetected) {
        return { success: false, groupId, spamDetected: true, error: 'Akun terdeteksi spam/blocked' };
      }

      // Check if group exists / is accessible
      const pageUrl = page.url();
      const groupNotFound = await page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes('This group no longer exists') ||
          text.includes('Grup ini sudah tidak ada') ||
          text.includes('Page Not Available') ||
          text.includes('Halaman Tidak Tersedia') ||
          text.includes('Sorry, this page isn\'t available')
        );
      });
      if (groupNotFound || !pageUrl.includes('/groups/')) {
        return { success: false, groupId, groupNotFound: true, error: 'Grup tidak ditemukan / tidak tersedia' };
      }

      // Detect join button state and click
      if (onProgress) onProgress({ status: 'clicking_join', attempt });

      const joinResult = await page.evaluate(() => {
        const buttons = document.querySelectorAll('[role="button"], button, a[role="button"]');
        let alreadyJoined = false;
        let clicked = false;
        let pendingApproval = false;
        let buttonText = '';

        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const combined = text + ' ' + ariaLabel;

          // Check if already joined
          if (combined.includes('joined') || combined.includes('terkait') ||
              combined.includes('member') || combined.includes('anggota') ||
              combined.includes('leave') || combined.includes('keluar')) {
            alreadyJoined = true;
            buttonText = text || ariaLabel;
            break;
          }

          // Check for join / request to join button
          if (combined.includes('join') || combined.includes('gabung') ||
              combined.includes('bergabung') || combined.includes('request to join') ||
              combined.includes('minta bergabung') || combined.includes('request')) {
            // Make sure it's not a "leave" or "joined" button
            if (!combined.includes('leave') && !combined.includes('keluar') &&
                !combined.includes('joined') && !combined.includes('terkait')) {
              btn.click();
              clicked = true;
              buttonText = text || ariaLabel;
              // Check if it's a "request to join" (pending approval)
              if (combined.includes('request') || combined.includes('minta')) {
                pendingApproval = true;
              }
              break;
            }
          }
        }

        return { alreadyJoined, clicked, pendingApproval, buttonText };
      });

      if (joinResult.alreadyJoined) {
        console.log(`ℹ️ [${getFormattedTime()}] Grup ${groupId} sudah di-join (${joinResult.buttonText})`);
        return { success: true, groupId, alreadyJoined: true, attempts: attempt };
      }

      if (joinResult.clicked) {
        await delay(2000);

        // Verify join was successful — check if button changed or confirmation appeared
        const verifyResult = await page.evaluate(() => {
          const text = document.body.innerText;
          const buttons = document.querySelectorAll('[role="button"], button');
          let nowJoined = false;
          for (const btn of buttons) {
            const btnText = (btn.textContent || '').trim().toLowerCase();
            if (btnText.includes('joined') || btnText.includes('terkait') ||
                btnText.includes('member') || btnText.includes('anggota') ||
                btnText.includes('leave') || btnText.includes('keluar')) {
              nowJoined = true;
              break;
            }
          }
          // Also check for confirmation messages
          const hasConfirmation = text.includes('You are now a member') ||
                                  text.includes('Anda sekarang anggota') ||
                                  text.includes('Request sent') ||
                                  text.includes('Permintaan terkirim') ||
                                  text.includes('Your request has been sent');
          return { nowJoined, hasConfirmation };
        });

        if (verifyResult.nowJoined || verifyResult.hasConfirmation) {
          console.log(`✅ [${getFormattedTime()}] Berhasil join grup ${groupId}`);
          return {
            success: true,
            groupId,
            alreadyJoined: false,
            pendingApproval: joinResult.pendingApproval,
            attempts: attempt
          };
        }

        // Button was clicked but no confirmation — might still work, give it a moment
        await delay(2000);
        console.log(`⚠️ [${getFormattedTime()}] Join grup ${groupId} — klik berhasil tapi belum terkonfirmasi`);
        return {
          success: true,
          groupId,
          alreadyJoined: false,
          pendingApproval: joinResult.pendingApproval,
          unconfirmed: true,
          attempts: attempt
        };
      }

      // No join button found
      lastError = new Error('Tombol join tidak ditemukan di halaman grup');
      console.log(`❌ [${getFormattedTime()}] ${lastError.message} untuk grup ${groupId}`);

    } catch (error) {
      lastError = error;
      console.log(`❌ [${getFormattedTime()}] Attempt ${attempt} gagal: ${error.message}`);
    }

    if (attempt < maxRetries) {
      console.log(`⏳ Retry dalam ${retryDelay / 1000} detik...`);
      await delay(retryDelay);
    }
  }

  console.log(`❌ [${getFormattedTime()}] FINAL FAIL join grup ${groupId}`);
  return { success: false, groupId, error: lastError?.message, attempts: maxRetries };
}

async function scanGroups(page, options = {}) {
  const { maxScrolls = 30, scrollDelay = 1500, onProgress } = options;
  const groupIds = new Set();
  
  await page.goto('https://facebook.com/groups/feed', { waitUntil: 'networkidle2' });
  await delay(3000);
  
  for (let i = 0; i < maxScrolls; i++) {
    if (onProgress) onProgress({ scroll: i + 1, maxScrolls, current: groupIds.size });
    await page.evaluate(() => window.scrollBy(0, 500));
    await delay(scrollDelay);
    
    const found = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/groups/"]'))
        .map(a => a.href.match(/\/groups\/(\d+)/)?.[1])
        .filter(Boolean);
    });
    found.forEach(id => groupIds.add(id));
  }
  
  return { groupIds: Array.from(groupIds), total: groupIds.size };
}

module.exports = {
  launchBrowserWithCookies,
  postToGroup,
  joinGroupOnPage,
  scanGroups,
  scanMyJoinedGroups,
  extractGroupsFromPage,
  getImageFilesFromFolder,
  getFormattedTime,
  isNetworkTimeoutMessage,
  isPostBoxNotFoundMessage,
  delay
};
