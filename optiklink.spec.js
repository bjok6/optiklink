// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [email, password] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [panelUser, panelPass] = (process.env.PANEL_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result, serverName = 'OptikLink') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 OptikLink 保活通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: ${serverName}`,
            `📊 执行结果: ${result}`,
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

// 处理 Discord 登录页（填账密）
async function handleDiscordLogin(page, email, password) {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    try {
        await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 15000 });
    } catch {
        let err = '账密错误或触发了 2FA / 验证码';
        try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
        throw new Error(`❌ Discord 登录失败: ${err}`);
    }
}

// 处理 Discord OAuth 授权页
async function handleOAuthPage(page) {
    await page.waitForTimeout(2000);

    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;

        try {
            const btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 3000 });
            const text = (await btn.innerText()).trim();

            if (/scroll/i.test(text) || text.includes('滚动')) {
                await page.evaluate(() => {
                    const s = document.querySelector('[class*="scroller"]')
                        || document.querySelector('[class*="scrollerBase"]')
                        || document.querySelector('[class*="content"]');
                    if (s) s.scrollTop = s.scrollHeight;
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await page.waitForTimeout(1500);
                await btn.click();
                await page.waitForTimeout(1500);
            } else if (/authorize/i.test(text) || text.includes('授权')) {
                await btn.click();
                await page.waitForTimeout(3000);
                return;
            } else {
                await page.waitForTimeout(1500);
            }
        } catch {
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com'), { timeout: 10000 });
            } catch { /* 继续等待 */ }
            return;
        }
    }
}

test('OptikLink 保活', async ({ }, testInfo) => {
    const proxyUrl = '';

    if (!email || !password) {
        throw new Error('❌ 缺少账号配置，格式: DISCORD_ACCOUNT=email,password');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                    () => resolve()
                );
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    } else if (proxyUrl) {
        proxyConfig = { server: proxyUrl };
        console.log(`🛡️ 使用代理: ${proxyUrl.replace(/:\/\/.*@/, '://***@')}`);
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    let activePage = page;

    await page.addInitScript(() => {
        if (!location.hostname.includes('optiklink.net')) return;

        const AD_DOMAINS = [
            'tzegilo.com', 'alwingulla.com', 'auqot.com', 'jmosl.com', '094kk.com',
            'optiklink.com', 'tmll7.com', 'oundhertobeconsist.org',
            'pagead2.googlesyndication.com', 'googlesyndication.com',
            'googletagservices.com', 'doubleclick.net',
            'adsbygoogle', 'popads', 'popcash', 'clickadu', 'tsyndicate',
            'trafficjunky', 'afu.php',
        ];
        const isAd = (url) => url && AD_DOMAINS.some(d => url.includes(d));

        const _createElement = document.createElement.bind(document);
        document.createElement = function (tag) {
            const el = _createElement(tag);
            if (tag.toLowerCase() === 'script') {
                const _desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
                Object.defineProperty(el, 'src', {
                    set(val) { if (!isAd(val)) _desc.set.call(this, val); },
                    get() { return _desc.get.call(this); },
                });
            }
            return el;
        };

        const _write = document.write.bind(document);
        document.write = function (html) { if (!isAd(html)) return _write(html); };

        const _appendChild = Element.prototype.appendChild;
        Element.prototype.appendChild = function (node) {
            if (node?.tagName === 'SCRIPT' && isAd(node.src)) return node;
            return _appendChild.call(this, node);
        };

        const _insertBefore = Element.prototype.insertBefore;
        Element.prototype.insertBefore = function (node, ref) {
            if (node?.tagName === 'SCRIPT' && isAd(node.src)) return node;
            return _insertBefore.call(this, node, ref);
        };

        const _fetch = window.fetch;
        window.fetch = function (url, ...args) {
            if (isAd(typeof url === 'string' ? url : url?.url))
                return Promise.reject(new Error('blocked'));
            return _fetch.call(this, url, ...args);
        };

        const _xhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
            if (isAd(url)) return;
            return _xhrOpen.call(this, method, url, ...args);
        };

        const _open = window.open.bind(window);
        window.open = function (url, ...args) {
            if (!url) return null;
            if (url.startsWith('/') || url.includes('optiklink.net')) return _open(url, ...args);
            return null;
        };

        const _addEL = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
            if (type === 'click' && (this === window || this === document)) {
                const src = fn?.toString() || '';
                if (/setTimeout\s*\(\s*\w\s*,\s*0\s*\)/.test(src)) return;
                if (/contextmenu.*localStorage|localStorage.*contextmenu/s.test(src)) return;
            }
            return _addEL.call(this, type, fn, opts);
        };

        Object.defineProperty(window, 'adsbygoogle', {
            get: () => ({ loaded: true, push: () => {} }),
            set: () => {},
            configurable: false,
        });
    });

    console.log('🚀 浏览器就绪！');
    console.log('🛡️ OptikLink 广告猎手启动');

    try {
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        console.log('🔑 打开 OptikLink 登录页...');
        await page.goto('https://optiklink.com/auth', { waitUntil: 'domcontentloaded' });

        console.log('📤 点击 Login with Discord...');
        await page.click("a[href='login']");

        console.log('⏳ 等待跳转 Discord 登录页...');
        await page.waitForURL(url => !url.toString().includes('optiklink.com/auth'), { timeout: TIMEOUT });

        const landedUrl = page.url();

        if (landedUrl.includes('discord.com/login')) {
            console.log('✏️ 填写账号密码...');
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);
            console.log('📤 提交登录请求...');
            await page.click('button[type="submit"]');
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 15000 });
            } catch {
                let err = '账密错误或触发了 2FA / 验证码';
                try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                await sendTG(`❌ Discord 登录失败：${err}`);
                throw new Error(`❌ Discord 登录失败: ${err}`);
            }
        } else if (landedUrl.includes('discord.com/oauth2')) {
            // 检查按钮：Log In 说明没有登录态，需先登录
            try {
                const btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 5000 });
                const btnText = (await btn.innerText()).trim();
                if (/log\s*in/i.test(btnText) || btnText.includes('登录')) {
                    console.log('✏️ 填写账号密码...');
                    await btn.click();
                    await page.waitForURL(/discord\.com\/login/, { timeout: 10000 });
                    await page.fill('input[name="email"]', email);
                    await page.fill('input[name="password"]', password);
                    console.log('📤 提交登录请求...');
                    await page.click('button[type="submit"]');
                    try {
                        await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 15000 });
                    } catch {
                        let err = '账密错误或触发了 2FA / 验证码';
                        try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                        await sendTG(`❌ Discord 登录失败：${err}`);
                        throw new Error(`❌ Discord 登录失败: ${err}`);
                    }
                }
            } catch (e) {
                if (e.message.includes('Discord 登录失败')) throw e;
                // 找不到按钮说明已自动处理
            }
        }

        // 处理可能出现的 OAuth 授权页
        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            console.log('  📄 当前在 Discord 授权页面');
            await handleOAuthPage(page);
            console.log('  ✨ 已授权，等待自动跳转...');
            try {
                await page.waitForURL(/optiklink\.net/, { timeout: 15000 });
                console.log('  ⏳ 跳转中，稍候...');
            } catch { /* 继续 */ }
            console.log(`✅ 已离开 Discord，当前：${page.url()}`);
        } catch (e) {
            if (e.message.includes('Discord 登录失败')) throw e;
        }

        // ✅ 修复：OAuth 授权后若被重定向回 discord.com/login，再次填写账密登录
        if (page.url().includes('discord.com/login')) {
            console.log('🔄 OAuth 后被重定向至登录页，再次填写账号密码...');
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);
            console.log('📤 提交登录请求...');
            await page.click('button[type="submit"]');
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 20000 });
                console.log(`✅ 二次登录后跳转至：${page.url()}`);
            } catch {
                let err = '账密错误或触发了 2FA / 验证码';
                try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                await sendTG(`❌ Discord 二次登录失败：${err}`);
                throw new Error(`❌ Discord 二次登录失败: ${err}`);
            }

            // 二次登录后可能再次出现 OAuth 授权页
            if (page.url().includes('discord.com/oauth2')) {
                console.log('🔍 二次进入 OAuth 授权页，处理中...');
                await handleOAuthPage(page);
                try {
                    await page.waitForURL(/optiklink\.net/, { timeout: 15000 });
                } catch { /* 继续 */ }
                console.log(`✅ OAuth 二次处理完成，当前：${page.url()}`);
            }
        }

        console.log('⏳ 确认到达 OptikLink...');
        try {
            await page.waitForURL(/optiklink\.net/, { timeout: 30000 });
        } catch { /* 可能已经在页面 */ }

        if (!page.url().includes('optiklink.net')) {
            throw new Error(`❌ 未到达 OptikLink，当前 URL: ${page.url()}`);
        }
        console.log(`✅ 登录成功！当前：${page.url()}`);

        console.log('📤 点击 Login to Panel...');
        await page.click('a[data-target="#logintopanel"]');
        await page.waitForTimeout(2000);

        console.log('📤 点击 Panel Login...');

        // 最佳实践：通过 Role 和文本定位按钮，并显式等待其完全可见
        const panelLoginBtn = page.getByRole('button', { name: 'Panel Login' });
        await panelLoginBtn.waitFor({ state: 'visible' });

        const [panelPage] = await Promise.all([
            page.context().waitForEvent('page'),
            panelLoginBtn.click(),
        ]);

        panelPage.setDefaultTimeout(TIMEOUT);
        activePage = panelPage;
        console.log('⏳ 等待控制台页面加载...');
        await panelPage.waitForURL(/control\.optiklink\.net/, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
        
        const currentUrl = panelPage.url();
        console.log(`✅ 已到达控制台页面：${currentUrl}`);

        // 修复点2：判断当前是否真的在登录页，如果在首页说明已经自动登录了
        if (currentUrl.includes('/auth/login')) {
            console.log('✏️ 填写控制台账号密码...');
            await panelPage.fill('input[name="username"]', panelUser);
            await panelPage.fill('input[name="password"]', panelPass);

            console.log('⏳ 等待 reCAPTCHA 加载...');
            await panelPage.waitForFunction(() => {
                return typeof grecaptcha !== 'undefined' && grecaptcha.getResponse !== undefined;
            }, { timeout: 15000 }).catch(() => console.log('  ℹ️ reCAPTCHA 未检测到，继续...'));
            await panelPage.waitForTimeout(2000);

            console.log('📤 提交控制台登录...');
            await panelPage.click('button[type="submit"]');

            console.log('⏳ 确认到达控制台首页...');
            // 这里同样加上 waitUntil: 'domcontentloaded'
            await panelPage.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
            console.log(`✅ 控制台登录成功！当前：${panelPage.url()}`);
        } else {
            console.log('ℹ️ 检测到已不在登录页，可能已自动鉴权并跳转至首页...');
        }

        await panelPage.waitForTimeout(2000);

        console.log('🔍 查找服务器...');
        await panelPage.waitForTimeout(2000);

        const serverInfo = await panelPage.evaluate(() => {
            const card = document.querySelector('a[href*="/server/"]');
            if (!card) return null;
            const href = card.getAttribute('href');
            const id = href.replace('/server/', '').trim();
            const nameEl = card.querySelector('p.sc-1ibsw91-5');
            const name = nameEl ? nameEl.innerText.trim() : '';
            return { id, name };
        });

        if (!serverInfo) throw new Error('❌ 未找到服务器卡片');
        console.log(`✅ 找到服务器：${serverInfo.name} (${serverInfo.id})`);

        await panelPage.goto(`https://control.optiklink.net/server/${serverInfo.id}`, { waitUntil: 'domcontentloaded' });
        console.log(`✅ 已到达服务器页面：${panelPage.url()}`);

        const serverPage = panelPage;

        console.log('🔍 检查服务器状态...');
        await serverPage.waitForTimeout(3000);

        // 若服务器处于 CONNECTING / STARTING 等中间态，等待稳定
        let statusText = '';
        for (let i = 0; i < 12; i++) {
            statusText = await serverPage.locator('p.sc-168cvuh-1').innerText().catch(() => '');
            const s = statusText.toLowerCase();
            if (s.includes('running') || s.includes('offline') || s.includes('stopped')) break;
            console.log(`  🔄 等待状态稳定（${statusText.trim()}）...`);
            await serverPage.waitForTimeout(5000);
        }

        console.log(`💻 服务器状态：${statusText.trim()}`);

        if (statusText.toLowerCase().includes('running')) {
            console.log('🎉 保活成功！');
            await sendTG('✅ 保活成功！\n💻 服务器状态：🚀 Running', serverInfo.name);
        } else if (statusText.toLowerCase().includes('offline') || statusText.toLowerCase().includes('stopped')) {
            console.log('⚠️ 服务器离线，尝试启动...');
            await serverPage.click('button:has-text("Start")');
            console.log('📤 已点击 Start，持续监控状态...');

            let started = false;
            for (let i = 0; i < 24; i++) {
                await serverPage.waitForTimeout(5000);
                const s = await serverPage.locator('p.sc-168cvuh-1').innerText().catch(() => '');
                console.log(`  🔄 第 ${i + 1} 次检查，状态：${s.trim()}`);
                if (s.toLowerCase().includes('running')) {
                    started = true;
                    break;
                }
            }

            if (started) {
                console.log('✅ 服务器已成功启动！');
                await sendTG('🔄 Start 启动！\n💻 服务器状态：🚀 Running', serverInfo.name);
            } else {
                console.log('❌ 等待超时，服务器未能启动');
                await sendTG('❌ Start 启动失败，等待超时\n💻 服务器状态：💤 Offline', serverInfo.name);
            }
        } else {
            console.log(`⚠️ 未知状态：${statusText.trim()}`);
            await sendTG(`⚠️ 状态未知\n💻 服务器状态：❓ ${statusText.trim()}`, serverInfo.name);
        }

    } catch (e) {
        try {
            const screenshotPath = testInfo.outputPath('failure.png');
            await activePage.screenshot({ path: screenshotPath, fullPage: true });
            await testInfo.attach('failure', { path: screenshotPath, contentType: 'image/png' });
            console.log('📸 失败截图已保存');
        } catch { /* 截图失败不影响主流程 */ }
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;

    } finally {
        await browser.close();
    }
});
