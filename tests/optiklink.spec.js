// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [email, password] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const PANEL_API_KEY = process.env.PANEL_API_KEY || ''; // 填入控制台生成的 API Key (如 ptlc_xxx)
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
            `🎮 OptikLink 保活与巡检通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: ${serverName}`,
            `📊 执行结果:\n${result}`,
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

// 🧮 主站数学验证码自动求解
async function solveMathCaptcha(page) {
    try {
        const captchaLabel = page.locator('label:has-text("+"), label:has-text("-"), label:has-text("*"), .captcha-text, [id*="captcha"]');
        if (await captchaLabel.count() > 0) {
            const text = await captchaLabel.first().innerText();
            const match = text.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
            if (match) {
                const n1 = parseInt(match[1]);
                const op = match[2];
                const n2 = parseInt(match[3]);
                let ans = 0;
                if (op === '+') ans = n1 + n2;
                else if (op === '-') ans = n1 - n2;
                else if (op === '*') ans = n1 * n2;

                console.log(`🧮 识别到主站数学算式: ${n1} ${op} ${n2} = ${ans}`);
                const captchaInput = page.locator('input[name="captcha"], input[placeholder*="captcha"], #captcha');
                if (await captchaInput.count() > 0) {
                    await captchaInput.fill(ans.toString());
                    console.log('✅ 数学验证码填写完成');
                }
            }
        }
    } catch (e) {
        console.log(`ℹ️ 数学验证码处理跳过: ${e.message}`);
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

// 📡 Pterodactyl API 请求封装（绕过网页端 reCAPTCHA）
function callPanelAPI(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        if (!PANEL_API_KEY) {
            return reject(new Error('未配置 PANEL_API_KEY 环境变量'));
        }

        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'control.optiklink.net',
            path: `/api/client${path}`,
            method: method,
            headers: {
                'Authorization': `Bearer ${PANEL_API_KEY}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
                } catch {
                    resolve({ status: res.statusCode, data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test('OptikLink 自动化保活与巡检', async ({ }, testInfo) => {
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

    // 广告拦截
    await page.addInitScript(() => {
        if (!location.hostname.includes('optiklink.net') && !location.hostname.includes('optiklink.com')) return;

        const AD_DOMAINS = [
            'tzegilo.com', 'alwingulla.com', 'auqot.com', 'jmosl.com', '094kk.com',
            'tmll7.com', 'oundhertobeconsist.org',
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

        Object.defineProperty(window, 'adsbygoogle', {
            get: () => ({ loaded: true, push: () => {} }),
            set: () => {},
            configurable: false,
        });
    });

    console.log('🚀 浏览器就绪！');

    try {
        // ================= 1. 主站 3 天登录保活 =================
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

        // 计算数学验证码
        await solveMathCaptcha(page);

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
            }
        }

        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await handleOAuthPage(page);
            try {
                await page.waitForURL(/optiklink\.net/, { timeout: 15000 });
            } catch { /* 继续 */ }
            console.log(`✅ 已离开 Discord，当前：${page.url()}`);
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
                try {
                    await page.waitForURL(/optiklink\.net/, { timeout: 15000 });
                } catch { /* 继续 */ }
            }
        }

        console.log('⏳ 确认到达 OptikLink 主站...');
        try {
            await page.waitForURL(/optiklink\.net|optiklink\.com\/dashboard/, { timeout: 30000 });
        } catch { /* 继续 */ }

        if (!page.url().includes('optiklink')) {
            throw new Error(`❌ 未到达 OptikLink 主站，当前 URL: ${page.url()}`);
        }
        console.log(`🎉 主站登录保活成功！当前页面：${page.url()}`);

        // 关闭主站浏览器，完成登录保活任务
        await browser.close();

        // ================= 2. 控制台 API 巡检与开机 =================
        console.log('\n📡 开始执行控制台 API 巡检 (直接调用 Pterodactyl 接口)...');

        if (!PANEL_API_KEY) {
            console.log('⚠️ 未检测到 PANEL_API_KEY 环境变量，跳过控制台巡检。');
            await sendTG('✅ 主站登录保活成功！\n⚠️ 未配置 PANEL_API_KEY，未跳过控制台巡检');
            return;
        }

        const serverListRes = await callPanelAPI('');
        if (serverListRes.status !== 200 || !serverListRes.data?.data) {
            throw new Error(`控制台 API 请求失败，HTTP 状态码: ${serverListRes.status}`);
        }

        const servers = serverListRes.data.data;
        console.log(`✅ 控制台 API 连接成功！发现 ${servers.length} 台服务器。`);

        let reportMsg = '✅ 主站 3 天保活已成功重置！\n';

        for (const item of servers) {
            const server = item.attributes;
            const serverId = server.identifier;
            const serverName = server.name;

            console.log(`🔍 正在检查服务器: [${serverName}] (ID: ${serverId})...`);
            const resourceRes = await callPanelAPI(`/servers/${serverId}/resources`);

            if (resourceRes.status === 200) {
                const currentState = resourceRes.data.attributes.current_state;
                console.log(`💻 当前状态: ${currentState}`);

                if (currentState === 'offline' || currentState === 'stopped') {
                    console.log('⚠️ 服务器处于离线状态，正在发送启动指令 [start]...');
                    const powerRes = await callPanelAPI(`/servers/${serverId}/power`, 'POST', { signal: 'start' });
                    
                    if (powerRes.status === 204) {
                        console.log('🚀 开机指令已成功发送！');
                        reportMsg += `🖥 [${serverName}]: 🔄 离线自动拉起中 (Running)`;
                    } else {
                        console.log(`❌ 发送开机指令失败: HTTP ${powerRes.status}`);
                        reportMsg += `🖥 [${serverName}]: ❌ 离线且开机失败 (HTTP ${powerRes.status})`;
                    }
                } else {
                    console.log('🎉 服务器运行正常！');
                    reportMsg += `🖥 [${serverName}]: 🚀 运行正常 (Running)`;
                }
            } else {
                console.log(`⚠️ 无法获取服务器状态，HTTP ${resourceRes.status}`);
                reportMsg += `🖥 [${serverName}]: ⚠️ 获取状态失败 (HTTP ${resourceRes.status})`;
            }
        }

        await sendTG(reportMsg);

    } catch (e) {
        try {
            const screenshotPath = testInfo.outputPath('failure.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            await testInfo.attach('failure', { path: screenshotPath, contentType: 'image/png' });
            console.log('📸 失败截图已保存');
        } catch { /* 忽略 */ }
        
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;
    }
});
