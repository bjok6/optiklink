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

// 🎙️ 音频转文字辅助函数 (Wit.ai / Free Speech API)
function transcribeAudio(audioUrl) {
    return new Promise((resolve) => {
        https.get(audioUrl, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const audioBuffer = Buffer.concat(chunks);
                const witKey = process.env.WIT_API_KEY || '564H4OQ3KJJ2M2L33KHK42J2L2K3J3K3';

                const req = https.request('https://api.wit.ai/speech', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${witKey}`,
                        'Content-Type': 'audio/mpeg',
                    }
                }, (witRes) => {
                    let body = '';
                    witRes.on('data', d => body += d);
                    witRes.on('end', () => {
                        try {
                            const match = body.match(/"text":\s*"([^"]+)"/);
                            if (match && match[1]) return resolve(match[1].trim());
                        } catch {}
                        resolve(null);
                    });
                });

                req.on('error', () => resolve(null));
                req.write(audioBuffer);
                req.end();
            });
        }).on('error', () => resolve(null));
    });
}

// 🤖 2. reCAPTCHA 自动语音识别求解
async function solveRecaptchaAudio(page) {
    try {
        console.log('🔍 正在检测 reCAPTCHA 验证码...');
        const recaptchaFrame = page.frames().find(f => f.url().includes('api2/anchor') || f.url().includes('enterprise/anchor'));
        if (!recaptchaFrame) {
            console.log('ℹ️ 未检测到 reCAPTCHA 框架');
            return;
        }

        const checkbox = recaptchaFrame.locator('#recaptcha-anchor');
        if (await checkbox.isVisible()) {
            console.log('🤖 点击 reCAPTCHA 人机身份验证复选框...');
            await checkbox.click();
            await page.waitForTimeout(2500);
        }

        const isChecked = await recaptchaFrame.locator('.recaptcha-checkbox-checked').count() > 0;
        if (isChecked) {
            console.log('✅ reCAPTCHA 自动通过（无图片/语音质询）');
            return;
        }

        const challengeFrame = page.frames().find(f => f.url().includes('api2/bframe') || f.url().includes('enterprise/bframe'));
        if (!challengeFrame) return;

        const audioBtn = challengeFrame.locator('#recaptcha-audio-button');
        if (await audioBtn.isVisible()) {
            console.log('🎙️ 点击语音验证码模式...');
            await audioBtn.click();
            await page.waitForTimeout(2500);
        }

        const errNotice = await challengeFrame.locator('.rc-doodle-error, .rc-audiochallenge-error-message').innerText().catch(() => '');
        if (errNotice.includes('automated queries') || errNotice.includes('自动查询')) {
            console.log('⚠️ reCAPTCHA 触发 IP 频控或机器人防御机制');
            return;
        }

        const audioLink = await challengeFrame.locator('#audio-source, .rc-audiochallenge-tdownload-link').getAttribute('src').catch(() => null)
            || await challengeFrame.locator('.rc-audiochallenge-tdownload-link').getAttribute('href').catch(() => null);

        if (audioLink) {
            console.log('📥 正在下载语音验证码并进行 STT 识别...');
            const transcript = await transcribeAudio(audioLink);
            if (transcript) {
                console.log(`🗣️ 语音转文字成功: "${transcript}"`);
                await challengeFrame.locator('#audio-response').fill(transcript);
                await challengeFrame.locator('#recaptcha-verify-button').click();
                await page.waitForTimeout(2500);
                console.log('✅ reCAPTCHA 语音验证码已成功提交！');
            } else {
                console.log('⚠️ 语音识别未返回有效内容');
            }
        }
    } catch (e) {
        console.log(`ℹ️ reCAPTCHA 处理抛出异常: ${e.message}`);
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
    } catch { /* 没找到按钮继续下一次循环 */ }
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

        // 🔄 Discord 鉴权状态机循环：支持各种跳转与二次重定向
        console.log('⏳ 正在处理 Discord 登录与 OAuth 授权...');
        const authStartTime = Date.now();
        while (Date.now() - authStartTime < 45000) {
            const currentUrl = page.url();

            // 如果已经跳回主站，直接退出循环
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

        console.log('📤 点击 Login to Panel 弹窗...');
        const modalBtn = page.locator('a[data-target="#logintopanel"], button[data-target="#logintopanel"], a:has-text("Login to Panel")').first();
        await modalBtn.click();
        await page.waitForTimeout(2000);

        console.log('📤 点击 Panel Login 跳转控制台...');
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

        if (currentUrl.includes('/auth/login')) {
            console.log('✏️ 填写控制台账号密码...');
            await panelPage.fill('input[name="username"]', panelUser);
            await panelPage.fill('input[name="password"]', panelPass);

            // 控制台 reCAPTCHA 语音处理
            await solveRecaptchaAudio(panelPage);

            console.log('📤 提交控制台登录...');
            await panelPage.click('button[type="submit"]');

            console.log('⏳ 确认到达控制台首页...');
            await panelPage.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
            console.log(`✅ 控制台登录成功！当前：${panelPage.url()}`);
        } else {
            console.log('ℹ️ 检测到已不在登录页，自动跳转至首页...');
        }

        await panelPage.waitForTimeout(2000);

        console.log('🔍 查找服务器...');
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
        } catch { /* 忽略 */ }
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;

    } finally {
        await browser.close();
    }
});
