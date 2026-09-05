// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [email, password] = (process.env.DISCORD_ACCOUNT || ',').split(',');
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

    console.log('🔧 启动防检测浏览器...');
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
        proxy: proxyConfig,
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    let activePage = page;

    // 抹除自动化特征
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

        if (!location.hostname.includes('optiklink.net') && !location.hostname.includes('optiklink.com')) return;

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
            if (url.startsWith('/') || url.includes('optiklink.net') || url.includes('optiklink.com')) return _open(url, ...args);
            return null;
        };
    });

    console.log('🚀 浏览器就绪！');

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
            console.log('✏️ 填写 Discord 账号密码...');
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
            try {
                const btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 5000 });
                const btnText = (await btn.innerText()).trim();
                if (/log\s*in/i.test(btnText) || btnText.includes('登录')) {
                    console.log('✏️ 填写 Discord 账号密码...');
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
            }
        }

        // 处理 Discord OAuth 授权页
        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await handleOAuthPage(page);
            console.log('✨ 已完成授权步骤');
        } catch (e) {
            if (e.message.includes('Discord 登录失败')) throw e;
        }

        if (page.url().includes('discord.com/login')) {
            console.log('🔄 OAuth 后被重定向至登录页，再次填写账号密码...');
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);
            await page.click('button[type="submit"]');
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 20000 });
            } catch {
                let err = '账密错误或触发了 2FA / 验证码';
                try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                await sendTG(`❌ Discord 二次登录失败：${err}`);
                throw new Error(`❌ Discord 二次登录失败: ${err}`);
            }

            if (page.url().includes('discord.com/oauth2')) {
                console.log('🔍 二次进入 OAuth 授权页，处理中...');
                await handleOAuthPage(page);
            }
        }

        console.log('✅ Discord OAuth 完成！');

        // ==================== Quick Verification 数学验证 ====================
        console.log('🌐 1. 跳转到 https://optiklink.net/login ...');
        await page.goto('https://optiklink.net/login', { waitUntil: 'domcontentloaded' });

        console.log('🧮 2. 开始执行 Quick Verification 数学验证...');
        await page.waitForTimeout(2000);

        const mathExpr = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
            if (match) {
                return {
                    full: match[0],
                    n1: parseInt(match[1], 10),
                    op: match[2],
                    n2: parseInt(match[3], 10)
                };
            }
            return null;
        });

        if (mathExpr) {
            let result = 0;
            if (mathExpr.op === '+') result = mathExpr.n1 + mathExpr.n2;
            else if (mathExpr.op === '-') result = mathExpr.n1 - mathExpr.n2;
            else if (mathExpr.op === '*') result = mathExpr.n1 * mathExpr.n2;

            console.log(`💡 计算验证题: ${mathExpr.full} = ${result}`);

            const inputLoc = page.locator('input[type="number"], input[name*="captcha" i], input[name*="answer" i], input[placeholder*="answer" i], input[type="text"]').first();
            await inputLoc.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
            if (await inputLoc.isVisible()) {
                await inputLoc.fill(String(result));
                console.log('✏️ 已成功填入验证结果');
            }
        }

        console.log('📤 3. 点击 CONTINUE WITH LOGIN...');
        const continueBtn = page.getByRole('button', { name: /CONTINUE WITH LOGIN/i })
            .or(page.locator('button:has-text("CONTINUE WITH LOGIN")'))
            .or(page.locator('a:has-text("CONTINUE WITH LOGIN")'))
            .first();

        if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await continueBtn.click();
            console.log('✨ 已点击 CONTINUE WITH LOGIN');
        }

        console.log('⏳ 4. 等待页面跳转至 Dashboard...');
        await page.waitForTimeout(3000);
        try {
            await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 20000 });
        } catch { /* 继续 */ }

        // ==================== 从主站弹窗获取 Panel 账密 ====================
        console.log('📤 5. 打开 Login to Panel 弹窗...');
        const panelModalTrigger = page.locator('a[data-target="#logintopanel"], button[data-target="#logintopanel"], a:has-text("Login to Panel")').first();
        await panelModalTrigger.waitFor({ state: 'visible', timeout: 10000 });
        await panelModalTrigger.click();
        await page.waitForTimeout(1500);

        console.log('🔍 提取 Panel 用户名与密码...');
        // 点击 [Click here to view] 展开真实密码
        const viewPasswordBtn = page.locator('text="[Click here to view]"').first();
        if (await viewPasswordBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await viewPasswordBtn.click();
            await page.waitForTimeout(1000);
        }

        const credentials = await page.evaluate(() => {
            const text = document.body.innerText;
            const uMatch = text.match(/Your Panel Username:\s*([a-zA-Z0-9_]+)/i);
            const pMatch = text.match(/Your Panel Password:\s*([^\s\n\r]+)/i);
            return {
                username: uMatch ? uMatch[1].trim() : null,
                password: pMatch ? pMatch[1].trim() : null
            };
        });

        const panelUser = process.env.PANEL_USER || credentials.username;
        const panelPass = process.env.PANEL_PASSWORD || credentials.password;

        if (!panelUser || !panelPass) {
            throw new Error(`❌ 未能成功提取控制台账密，提结果: username=${panelUser}, password=${panelPass ? '***' : 'null'}`);
        }
        console.log(`🔑 成功获取控制台账号: ${panelUser}`);

        console.log('📤 6. 点击 Panel Login 跳转控制台...');
        const panelLoginBtn = page.getByRole('button', { name: 'Panel Login' })
            .or(page.locator('a:has-text("Panel Login")'))
            .or(page.locator('button:has-text("Panel Login")'))
            .first();

        const [panelPage] = await Promise.all([
            context.waitForEvent('page').catch(() => page),
            panelLoginBtn.click(),
        ]);

        panelPage.setDefaultTimeout(TIMEOUT);
        activePage = panelPage;

        console.log('⏳ 7. 进入控制台页面，准备登录...');
        await panelPage.waitForLoadState('domcontentloaded');
        await panelPage.waitForTimeout(3000);

        // 如果已经在面板 Dashboard（说明 Cookie 有效无需登录）
        if (panelPage.url().includes('control.optiklink.net') && !panelPage.url().includes('/auth/login')) {
            console.log('🎉 控制台已自动进入 Dashboard，无需输入账密！');
        } else {
            console.log('✏️ 拟人化填入控制台账密（绕过人机检测）...');
            const userInput = panelPage.locator('input[name="username"], input[type="text"]').first();
            const passInput = panelPage.locator('input[name="password"], input[type="password"]').first();

            await userInput.waitFor({ state: 'visible', timeout: 15000 });

            // 点击并慢速输入用户名
            await userInput.click();
            await panelPage.waitForTimeout(400);
            await userInput.type(panelUser, { delay: 70 });

            // 点击慢速输入密码
            await panelPage.waitForTimeout(300);
            await passInput.click();
            await panelPage.waitForTimeout(400);
            await passInput.type(panelPass, { delay: 80 });

            // 模拟人类滑动鼠标提升 reCAPTCHA 评分
            await panelPage.mouse.move(250, 350);
            await panelPage.waitForTimeout(800);
            await panelPage.mouse.move(400, 500);
            await panelPage.waitForTimeout(800);

            console.log('📤 提交控制台登录...');
            const submitBtn = panelPage.locator('button[type="submit"], button:has-text("LOGIN"), button:has-text("Login")').first();
            await submitBtn.click();

            console.log('⏳ 等待控制台登录验证...');
            await panelPage.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 25000 });
        }

        console.log(`✅ 控制台登录成功！当前页面：${panelPage.url()}`);

        // ==================== 服务器状态检查与启动 ====================
        console.log('🔍 查找服务器...');
        await panelPage.waitForTimeout(3000);

        const serverInfo = await panelPage.evaluate(() => {
            const card = document.querySelector('a[href*="/server/"]');
            if (!card) return null;
            const href = card.getAttribute('href');
            const id = href.replace('/server/', '').trim();
            const nameEl = card.querySelector('p.sc-1ibsw91-5') || card.querySelector('p');
            const name = nameEl ? nameEl.innerText.trim() : 'My Server';
            return { id, name };
        });

        if (!serverInfo) throw new Error('❌ 未能在控制台找到服务器列表');
        console.log(`✅ 找到服务器：${serverInfo.name} (${serverInfo.id})`);

        await panelPage.goto(`https://control.optiklink.net/server/${serverInfo.id}`, { waitUntil: 'domcontentloaded' });
        console.log(`✅ 已进入服务器详情页：${panelPage.url()}`);

        const serverPage = panelPage;

        console.log('🔍 检查服务器运行状态...');
        await serverPage.waitForTimeout(3000);

        let statusText = '';
        for (let i = 0; i < 12; i++) {
            statusText = await serverPage.locator('p.sc-168cvuh-1, div[class*="status"]').first().innerText().catch(() => '');
            const s = statusText.toLowerCase();
            if (s.includes('running') || s.includes('offline') || s.includes('stopped')) break;
            console.log(`  🔄 等待状态加载（${statusText.trim()}）...`);
            await serverPage.waitForTimeout(5000);
        }

        console.log(`💻 当前状态：${statusText.trim()}`);

        if (statusText.toLowerCase().includes('running')) {
            console.log('🎉 保活成功！');
            await sendTG('✅ 保活成功！\n💻 服务器状态：🚀 Running', serverInfo.name);
        } else if (statusText.toLowerCase().includes('offline') || statusText.toLowerCase().includes('stopped')) {
            console.log('⚠️ 服务器处于停止状态，尝试启动...');
            await serverPage.click('button:has-text("Start")');
            console.log('📤 已点击 Start，开始监控...');

            let started = false;
            for (let i = 0; i < 24; i++) {
                await serverPage.waitForTimeout(5000);
                const s = await serverPage.locator('p.sc-168cvuh-1, div[class*="status"]').first().innerText().catch(() => '');
                console.log(`  🔄 状态监控 (${i + 1}/24)：${s.trim()}`);
                if (s.toLowerCase().includes('running')) {
                    started = true;
                    break;
                }
            }

            if (started) {
                console.log('✅ 服务器启动成功！');
                await sendTG('🔄 已尝试 Start！\n💻 服务器状态：🚀 Running', serverInfo.name);
            } else {
                console.log('❌ 启动超时');
                await sendTG('❌ Start 点击成功但启动超时\n💻 服务器状态：💤 Offline', serverInfo.name);
            }
        } else {
            console.log(`⚠️ 状态未明：${statusText.trim()}`);
            await sendTG(`⚠️ 状态未知\n💻 服务器状态：❓ ${statusText.trim()}`, serverInfo.name);
        }

    } catch (e) {
        try {
            const screenshotPath = testInfo.outputPath('failure.png');
            await activePage.screenshot({ path: screenshotPath, fullPage: true });
            await testInfo.attach('failure', { path: screenshotPath, contentType: 'image/png' });
            console.log('📸 失败截图已保存');
        } catch { /* 忽略截图错误 */ }
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;

    } finally {
        await browser.close();
    }
});
