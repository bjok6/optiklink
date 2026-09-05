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
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const msg = `🎮 OptikLink 保活通知\n🕐 运行时间: ${nowStr()}\n🖥 服务器: ${serverName}\n📊 执行结果: ${result}`;
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// 自动识别并破解 reCAPTCHA 语音验证码
async function solveAudioRecaptcha(page) {
    try {
        const frame = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
        if (!frame) return false;

        const audioBtn = frame.locator('#recaptcha-audio-button');
        if (await audioBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('🤖 检测到 reCAPTCHA 拦截，尝试通过语音验证破解...');
            await audioBtn.click();
            await page.waitForTimeout(2000);

            // 检查音频源
            const audioSrc = await frame.locator('#audio-source').getAttribute('src').catch(() => null);
            if (!audioSrc) {
                console.log('⚠️ 语音验证不可用（IP 频繁被限制）');
                return false;
            }

            // 下载 mp3 并调用语音转换
            const audioBuffer = await page.request.get(audioSrc).then(r => r.buffer());
            
            // 使用免费 Wit.ai 语音转文字 API 识别音频
            const sttRes = await page.request.post('https://api.wit.ai/speech', {
                headers: {
                    'Authorization': 'Bearer 677G5T334P7UGLP25T3S7S4I232G7HGL', // 免费通用 Speech Token
                    'Content-Type': 'audio/mpeg',
                },
                data: audioBuffer,
            });

            const sttJson = await sttRes.json().catch(() => ({}));
            const text = sttJson.text || sttJson._text;

            if (text) {
                console.log(`💡 语音识别成功结果: "${text.trim()}"`);
                await frame.locator('#audio-response').fill(text.trim());
                await frame.locator('#recaptcha-verify-button').click();
                await page.waitForTimeout(2000);
                return true;
            }
        }
    } catch (e) {
        console.log(`⚠️ 语音验证过程提示: ${e.message}`);
    }
    return false;
}

test('OptikLink 保活', async ({ }, testInfo) => {
    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        proxyConfig = { server: process.env.GOST_PROXY };
    }

    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        proxy: proxyConfig,
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    let activePage = page;

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
        console.log('🔑 打开 OptikLink 登录页...');
        await page.goto('https://optiklink.com/auth', { waitUntil: 'domcontentloaded' });
        await page.click("a[href='login']");

        await page.waitForURL(url => !url.toString().includes('optiklink.com/auth'), { timeout: TIMEOUT });

        // Discord 登录逻辑处理...
        if (page.url().includes('discord.com/login')) {
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(3000);
        }

        // ==================== 数学验证 ====================
        await page.goto('https://optiklink.net/login', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        const mathExpr = await page.evaluate(() => {
            const match = document.body.innerText.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
            return match ? { n1: parseInt(match[1]), op: match[2], n2: parseInt(match[3]) } : null;
        });

        if (mathExpr) {
            let res = mathExpr.op === '+' ? mathExpr.n1 + mathExpr.n2 : mathExpr.n1 - mathExpr.n2;
            const inputLoc = page.locator('input[type="number"], input[type="text"]').first();
            if (await inputLoc.isVisible()) await inputLoc.fill(String(res));
        }

        const continueBtn = page.locator('button:has-text("CONTINUE WITH LOGIN"), a:has-text("CONTINUE WITH LOGIN")').first();
        if (await continueBtn.isVisible().catch(() => false)) await continueBtn.click();
        await page.waitForTimeout(3000);

        // ==================== 提取 Panel 密码与跳转 ====================
        const panelModalTrigger = page.locator('a[data-target="#logintopanel"], button[data-target="#logintopanel"]').first();
        await panelModalTrigger.click();
        await page.waitForTimeout(1500);

        const viewPasswordBtn = page.locator('text="[Click here to view]"').first();
        if (await viewPasswordBtn.isVisible().catch(() => false)) await viewPasswordBtn.click();

        const credentials = await page.evaluate(() => {
            const text = document.body.innerText;
            const uMatch = text.match(/Your Panel Username:\s*([a-zA-Z0-9_]+)/i);
            const pMatch = text.match(/Your Panel Password:\s*([^\s\n\r]+)/i);
            return { username: uMatch ? uMatch[1] : null, password: pMatch ? pMatch[1] : null };
        });

        const panelLoginBtn = page.locator('a:has-text("Panel Login"), button:has-text("Panel Login")').first();
        const [panelPage] = await Promise.all([
            context.waitForEvent('page').catch(() => page),
            panelLoginBtn.click(),
        ]);

        activePage = panelPage;
        await panelPage.waitForLoadState('domcontentloaded');
        await panelPage.waitForTimeout(3000);

        // ==================== 控制台登录与人机验证破解 ====================
        if (!panelPage.url().includes('/auth/login')) {
            console.log('🎉 已静默登录控制台！');
        } else {
            console.log('✏️ 填入控制台账密...');
            await panelPage.locator('input[name="username"]').fill(credentials.username);
            await panelPage.locator('input[name="password"]').fill(credentials.password);
            
            console.log('📤 点击登录按钮...');
            await panelPage.locator('button[type="submit"]').click();
            await panelPage.waitForTimeout(3000);

            // 检查是否出现 reCAPTCHA 拦截并尝试语音破解
            await solveAudioRecaptcha(panelPage);

            console.log('⏳ 等待控制台登录跳转...');
            await panelPage.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 35000 });
        }

        console.log(`✅ 控制台登录成功！${panelPage.url()}`);
        await sendTG('✅ 保活成功！', 'OptikLink');

    } catch (e) {
        console.log(`❌ 异常: ${e.message}`);
        await sendTG(`❌ 脚本异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
