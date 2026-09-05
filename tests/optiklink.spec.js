// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 控制台登录会话文件：保存 control.optiklink.net 的 cookie，供后续运行复用、绕开 reCAPTCHA
const STATE_FILE = process.env.SESSION_FILE || path.join(process.cwd(), 'control-session.json');

function loadSavedState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return null;
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (!state || !Array.isArray(state.cookies) || state.cookies.length === 0) return null;
        return state;
    } catch (e) {
        console.log(`⚠️ 会话文件读取失败：${e.message}`);
        return null;
    }
}


async function saveState(context) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(await context.storageState(), null, 2));
        console.log(`💾 控制台会话已保存：${STATE_FILE}`);
        return true;
    } catch (e) {
        console.log(`⚠️ 会话保存失败：${e.message}`);
        return false;
    }
}
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

// 🧮 1. 主站数学验证码自动求解
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

                console.log(`🧮 识别到数学算式: ${n1} ${op} ${n2} = ${ans}`);
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

// 🎙️ 音频转文字辅助函数（走浏览器代理下载 + 15s 超时，避免卡死）
async function transcribeAudio(page, audioUrl) {
    try {
        const resp = await page.request.get(audioUrl, { timeout: 15000 });
        if (!resp.ok()) return null;
        const audioBuffer = await resp.body();
        const witKey = process.env.WIT_API_KEY || '564H4OQ3KJJ2M2L33KHK42J2L2K3J3K3';

        const body = await new Promise((resolve) => {
            const req = https.request('https://api.wit.ai/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${witKey}`,
                    'Content-Type': 'audio/mpeg',
                },
                timeout: 15000,
            }, (witRes) => {
                let data = '';
                witRes.on('data', d => data += d);
                witRes.on('end', () => resolve(data));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(audioBuffer);
            req.end();
        });

        const match = body && body.match(/"text":\s*"([^"]+)"/);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
}

// 🤖 2. reCAPTCHA 自动处理：先等勾选框并尝试自动通过，失败再走语音质询
async function solveRecaptchaAudio(page) {
    try {
        console.log('🔍 正在检测 reCAPTCHA 验证码...');
        const frames = page.frames();
        const frameUrls = frames.map(f => f.url()).filter(Boolean).join(' | ');
        console.log('ℹ️ 当前 iframe: ' + (frameUrls || '(无)'));

        // 1) 等 reCAPTCHA 勾选框渲染出来（最多 10 秒）；可见则点击，期望直接通过
        let anchorFrame = null;
        for (let i = 0; i < 10 && !anchorFrame; i++) {
            anchorFrame = page.frames().find(f => /(api2|enterprise)\/anchor/.test(f.url()));
            if (!anchorFrame) await page.waitForTimeout(1000);
        }
        if (!anchorFrame) {
            console.log('ℹ️ 10 秒内未见 reCAPTCHA anchor 框架');
            return false;
        }

        const checkbox = anchorFrame.locator('#recaptcha-anchor');
        if (await checkbox.isVisible().catch(() => false)) {
            console.log('🤖 点击 reCAPTCHA 人机身份验证复选框...');
            await checkbox.click({ force: true });
            await page.waitForTimeout(2500);
            const isChecked = await anchorFrame.locator('.recaptcha-checkbox-checked').count().catch(() => 0) > 0;
            if (isChecked) {
                console.log('✅ reCAPTCHA 自动通过（无图片/语音质询）');
                return true;
            }
        } else {
            console.log('ℹ️ 勾选框不可见（可能是 invisible 模式，提交后才会弹出质询）');
        }

        // 2) 若已有弹出的质询，尝试语音求解
        const challengeFrame = page.frames().find(f => /(api2|enterprise)\/bframe/.test(f.url()));
        if (!challengeFrame) {
            console.log('ℹ️ 暂无可见质询，等待提交后触发');
            return false;
        }

        const audioBtn = challengeFrame.locator('#recaptcha-audio-button');
        if (!(await audioBtn.isVisible().catch(() => false))) {
            console.log('ℹ️ 未找到语音模式入口，跳过语音处理');
            return false;
        }
        console.log('🎙️ 点击语音验证码模式...');
        await audioBtn.click({ force: true });

        // 等待语音面板出现（最多 8 秒），不要用默认 60 秒超时
        const audioSource = challengeFrame.locator('#audio-source').first();
        try {
            await audioSource.waitFor({ state: 'attached', timeout: 8000 });
        } catch {
            console.log('⚠️ 语音质询未能加载（#audio-source 未出现），跳过语音处理');
            return false;
        }

        // 错误提示用 1.5 秒短探测；正常打开语音质询时不会出现该元素
        const errNotice = await challengeFrame
            .locator('.rc-doodle-error, .rc-audiochallenge-error-message')
            .first().innerText({ timeout: 1500 }).catch(() => '');
        if (errNotice.includes('automated queries') || errNotice.includes('自动查询')) {
            console.log('⚠️ reCAPTCHA 触发 IP 频控或机器人防御机制');
            return false;
        }

        // 音频地址先取 src，失败再退回取 href，各 3 秒
        let audioLink = await audioSource.getAttribute('src', { timeout: 3000 }).catch(() => null);
        if (!audioLink) {
            audioLink = await challengeFrame.locator('.rc-audiochallenge-tdownload-link')
                .first().getAttribute('href', { timeout: 3000 }).catch(() => null);
        }
        if (!audioLink) {
            console.log('⚠️ 未取到语音下载地址，跳过语音处理');
            return false;
        }

        console.log('📥 正在下载语音验证码并进行 STT 识别...');
        const transcript = await transcribeAudio(page, audioLink);
        if (transcript) {
            console.log(`🗣️ 语音转文字成功: "${transcript}"`);
            await challengeFrame.locator('#audio-response').fill(transcript);
            await challengeFrame.locator('#recaptcha-verify-button').click({ force: true });
            await page.waitForTimeout(2500);
            console.log('✅ reCAPTCHA 语音验证码已提交！');
            return true;
        }
        console.log('⚠️ 语音识别未返回有效内容');
        return false;
    } catch (e) {
        console.log(`ℹ️ reCAPTCHA 处理抛出异常: ${e.message}`);
        return false;
    }
}

// 单次处理 Discord OAuth 授权按钮
async function handleOAuthPageOnce(page) {
    try {
        const btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 4000 });
        const text = (await btn.innerText()).trim();

        if (/scroll/i.test(text) || text.includes('滚动')) {
            await page.evaluate(() => {
                const s = document.querySelector('[class*="scroller"]')
                    || document.querySelector('[class*="scrollerBase"]')
                    || document.querySelector('[class*="content"]');
                if (s) s.scrollTop = s.scrollHeight;
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1000);
            await btn.click();
        } else if (/authorize/i.test(text) || text.includes('授权')) {
            await btn.click();
            console.log('  ✨ 已点击授权按钮');
        }
    } catch { /* 没找到按钮继续 */ }
}

test('OptikLink 保活', async ({ }, testInfo) => {
    const proxyUrl = 'socks5://127.0.0.1:1080';

    if ((!email || !password) && !loadSavedState()) {
        throw new Error('❌ 缺少账号配置，格式: DISCORD_ACCOUNT=email,password');
    }

    let proxyConfig = undefined;
    if (proxyUrl) {
        proxyConfig = { server: proxyUrl };
        console.log(`🛡️ 使用代理: ${proxyUrl}`);
    }

    console.log('🔧 启动浏览器...');
    // 优先用系统真实 Chrome（GH runner 自带），降低被 reCAPTCHA 识别为自动化浏览器的概率
    const launchOptions = {
        headless: true,
        proxy: proxyConfig,
        args: ['--disable-blink-features=AutomationControlled'],
    };
    let browser;
    try {
        browser = await chromium.launch({ ...launchOptions, channel: process.env.PW_CHANNEL || 'chrome' });
    } catch (e) {
        console.log(`ℹ️ 系统 Chrome 不可用（${String(e.message).split('\n')[0]}），回退内置 Chromium`);
        browser = await chromium.launch(launchOptions);
    }
    
    // 先取真实 UA（去掉 HeadlessChrome 字样）
    const probe = await browser.newPage();
    const realUA = (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await probe.close();

    const context = await browser.newContext({
        proxy: proxyConfig,
        storageState: loadSavedState() || undefined,
        userAgent: realUA,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // 抹掉自动化指纹，尽量模拟真实浏览器（降低 reCAPTCHA 弹验证码概率）
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
        const origQuery = navigator.permissions && navigator.permissions.query;
        if (origQuery) {
            navigator.permissions.query = (p) =>
                p && p.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery.call(navigator.permissions, p);
        }
    });

    // 拦截弹窗与广告
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
    console.log('🛡️ OptikLink 广告拦截增强版启动');

    try {
        // 1) 会话快路径：先直接访问控制台；若已保存的登录会话仍有效，则跳过 Discord/面板登录与 reCAPTCHA
        console.log('🔑 尝试直接进入控制台（复用已保存会话）...');
        await page.goto('https://control.optiklink.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
        const sessionOk = page.url().includes('control.optiklink.net') && !page.url().includes('/auth/login');

        if (sessionOk) {
            console.log(`✅ 会话有效，直接进入控制台：${page.url()}`);
            if (page.url() !== 'https://control.optiklink.net/') {
                await page.goto('https://control.optiklink.net/', { waitUntil: 'domcontentloaded' });
            }
        } else {
            console.log('ℹ️ 无有效会话，开始完整登录流程...');
            if (!panelUser || !panelPass) {
                throw new Error('❌ 缺少控制台账号配置 PANEL_ACCOUNT=user,pass');
            }
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

            // 主站数学验证码
            await solveMathCaptcha(page);

            console.log('📤 点击 Login with Discord...');
            await page.click("a[href='login']");

            // 🔄 Discord 鉴权状态机循环
            console.log('⏳ 正在处理 Discord 登录与 OAuth 授权...');
            const authStartTime = Date.now();
            while (Date.now() - authStartTime < 45000) {
                const currentUrl = page.url();

                if (currentUrl.includes('optiklink.net') || (currentUrl.includes('optiklink.com') && !currentUrl.includes('discord.com'))) {
                    break;
                }

                if (currentUrl.includes('discord.com/login')) {
                    console.log('✏️ 处于 Discord 登录页，填写账号密码...');
                    await page.fill('input[name="email"]', email);
                    await page.fill('input[name="password"]', password);
                    console.log('📤 提交 Discord 登录请求...');
                    await page.click('button[type="submit"]');
                    try {
                        await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 15000 });
                    } catch {
                        let err = '账密错误或触发了 2FA / 验证码';
                        try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                        await sendTG(`❌ Discord 登录失败：${err}`);
                        throw new Error(`❌ Discord 登录失败: ${err}`);
                    }
                } else if (currentUrl.includes('discord.com/oauth2')) {
                    console.log('🔍 进入 OAuth 授权页，处理授权按钮...');
                    await handleOAuthPageOnce(page);
                    await page.waitForTimeout(2000);
                } else {
                    await page.waitForTimeout(1500);
                }
            }

            console.log('⏳ 确认到达 OptikLink 主站...');
            try {
                await page.waitForURL(/optiklink\.net/, { timeout: 20000 });
            } catch { /* 继续 */ }

            if (!page.url().includes('optiklink.net')) {
                throw new Error(`❌ 未到达 OptikLink，当前 URL: ${page.url()}`);
            }
            console.log(`✅ 主站登录成功！当前：${page.url()}`);

            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(3000);

            console.log('✅ 主站登录成功！正在寻找控制面板入口...');
            const panelLink = page.locator('a[href*="control.optiklink.net"], a:has-text("Panel"), a:has-text("控制台"), a:has-text("管理"), a:has-text("Dashboard")').first();

            if (await panelLink.isVisible().catch(() => false)) {
                console.log('✨ 发现面板直达链接，正在点击以继承会话...');
                await Promise.all([
                    page.waitForURL(url => url.toString().includes('control.optiklink.net'), { timeout: 15000 }).catch(() => {}),
                    panelLink.click()
                ]);
            } else {
                console.log('ℹ️ 未发现直达链接，降级直接导航至控制台...');
                await page.goto('https://control.optiklink.net/auth/login', { waitUntil: 'domcontentloaded' });
            }

            console.log('⏳ 等待控制台页面加载...');
            await page.waitForURL(/control\.optiklink\.net/, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' }).catch(() => {});

            const currentUrl = page.url();
            console.log(`✅ 已到达控制台页面：${currentUrl}`);

            if (currentUrl.includes('/auth/login')) {
                console.log('✏️ 填写控制台账号密码...');
                await page.fill('input[name="username"]', panelUser);
                await page.fill('input[name="password"]', panelPass);

                console.log('⏳ 强制等待 3 秒，防止组件加载过慢...');
                await page.waitForTimeout(3000);

                // 控制台 reCAPTCHA 语音处理 (如果有可见质询)
                await solveRecaptchaAudio(page);

                // 重试机制：提交后若才弹出验证码质询则再解一次再重提，
                // 同时避免 "This recaptcha instance did not render yet." 的拦截
                let loginSuccess = false;
                let triedSolveAgain = false;
                for (let i = 0; i < 3; i++) {
                    console.log(`📤 提交控制台登录 (尝试 ${i + 1}/3)...`);
                    try {
                        await page.click('button[type="submit"]', { timeout: 5000 });
                    } catch {
                        console.log('⚠️ 提交按钮暂时不可点击（可能被验证码弹层遮挡），等待 2 秒重试');
                        await page.waitForTimeout(2000);
                        continue;
                    }

                    try {
                        await page.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 6000 });
                        loginSuccess = true;
                        break;
                    } catch { /* 没跳转说明登录被拒，继续排查 */ }

                    // invisible 模式常见：提交后才弹出质询。出现质询则尝试自动解一次再重新提交
                    const hasChallenge = page.frames().some(f => /(api2|enterprise)\/bframe/.test(f.url()));
                    if (hasChallenge && !triedSolveAgain) {
                        console.log('🔍 提交后检测到验证码质询，尝试自动求解...');
                        await page.waitForTimeout(1500);
                        await solveRecaptchaAudio(page);
                        triedSolveAgain = true;
                        continue;
                    }

                    const errorVisible = await page.getByText('recaptcha instance did not render yet', { exact: false }).isVisible().catch(() => false);
                    if (errorVisible) {
                        console.log('⚠️ 被拦截：reCAPTCHA 尚未在底层渲染完成，等待 5 秒后重试...');
                        await page.waitForTimeout(5000);
                    } else {
                        break;
                    }
                }

                if (!loginSuccess) {
                    // 明确报错，而不是用 waitForURL 抛难懂的 TimeoutError
                    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
                    const errLine = (bodyText.match(/[^\n]*(error|invalid|incorrect|错误|失败|验证|用户名|密码)[^\n]*/i) || [])[0];
                    const hint = errLine ? errLine.trim().slice(0, 200) : '页面无明确错误提示';
                    throw new Error(`❌ 控制台登录失败：仍停留在登录页（reCAPTCHA 未通过或账号密码有误）。提示：${hint}`);
                }
                console.log(`✅ 控制台登录成功！当前：${page.url()}`);
            } else {
                console.log('ℹ️ 检测到已不在登录页，直接进入首页...');
            }
            // 3) 登录成功/已在控制台 → 保存会话供下次复用，绕开 reCAPTCHA
            if (!page.url().includes('/auth/login')) {
                await saveState(context);
            }
        }

        await page.waitForTimeout(2000);

        console.log('🔍 查找服务器...');
        const serverInfo = await page.evaluate(() => {
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

        await page.goto(`https://control.optiklink.net/server/${serverInfo.id}`, { waitUntil: 'domcontentloaded' });
        console.log(`✅ 已到达服务器页面：${page.url()}`);

        console.log('🔍 检查服务器状态...');
        await page.waitForTimeout(3000);

        let statusText = '';
        for (let i = 0; i < 12; i++) {
            statusText = await page.locator('p.sc-168cvuh-1').innerText().catch(() => '');
            const s = statusText.toLowerCase();
            if (s.includes('running') || s.includes('offline') || s.includes('stopped')) break;
            console.log(`  🔄 等待状态稳定（${statusText.trim()}）...`);
            await page.waitForTimeout(5000);
        }

        console.log(`💻 服务器状态：${statusText.trim()}`);

        if (statusText.toLowerCase().includes('running')) {
            console.log('🎉 保活成功！');
            await sendTG('✅ 保活成功！\n💻 服务器状态：🚀 Running', serverInfo.name);
        } else if (statusText.toLowerCase().includes('offline') || statusText.toLowerCase().includes('stopped')) {
            console.log('⚠️ 服务器离线，尝试启动...');
            await page.click('button:has-text("Start")');
            console.log('📤 已点击 Start，持续监控状态...');

            let started = false;
            for (let i = 0; i < 24; i++) {
                await page.waitForTimeout(5000);
                const s = await page.locator('p.sc-168cvuh-1').innerText().catch(() => '');
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
            await page.screenshot({ path: screenshotPath, fullPage: true });
            await testInfo.attach('failure', { path: screenshotPath, contentType: 'image/png' });
            console.log('📸 失败截图已保存');
        } catch { /* 忽略 */ }
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;

    } finally {
        await browser.close();
    }
});
