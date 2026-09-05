const { test, chromium } = require('@playwright/test');
const https = require('https');

const [email, password] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [panelUser, panelPass] = (process.env.PANEL_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 40000;

function sendTG(msg) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({
            chat_id: TG_CHAT_ID,
            text: `🎮 OptikLink 保活通知\n🕐 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n${msg}`
        });
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

// 自动识别 reCAPTCHA 语音验证码
async function solveRecaptchaAudio(page) {
    try {
        const frame = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
        if (!frame) return false;

        const audioBtn = frame.locator('#recaptcha-audio-button');
        if (await audioBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
            console.log('🤖 触发 Google reCAPTCHA，尝试语音破解...');
            await audioBtn.click();
            await page.waitForTimeout(2000);

            const audioSrc = await frame.locator('#audio-source').getAttribute('src').catch(() => null);
            if (!audioSrc) return false;

            const audioBuffer = await page.request.get(audioSrc).then(r => r.buffer());
            const sttRes = await page.request.post('https://api.wit.ai/speech', {
                headers: {
                    'Authorization': 'Bearer 677G5T334P7UGLP25T3S7S4I232G7HGL',
                    'Content-Type': 'audio/mpeg',
                },
                data: audioBuffer,
            });

            const json = await sttRes.json().catch(() => ({}));
            const text = json.text || json._text;
            if (text) {
                console.log(`💡 语音识别成功: "${text.trim()}"`);
                await frame.locator('#audio-response').fill(text.trim());
                await frame.locator('#recaptcha-verify-button').click();
                await page.waitForTimeout(2000);
                return true;
            }
        }
    } catch (e) {
        console.log(`⚠️ 语音识别跳过: ${e.message}`);
    }
    return false;
}

test('OptikLink 保活', async () => {
    const proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;

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

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let mainSiteOk = false;
    let panelOk = false;

    try {
        // ==================== 1. 主站保活 ====================
        console.log('🔑 [1/2] 打开 OptikLink 主站...');
        await page.goto('https://optiklink.net/login', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        if (page.url().includes('discord.com')) {
            console.log('🔑 填入 Discord 账号密码...');
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(4000);
        }

        if (page.url().includes('optiklink.net/login')) {
            const mathExpr = await page.evaluate(() => {
                const match = document.body.innerText.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
                return match ? { n1: parseInt(match[1]), op: match[2], n2: parseInt(match[3]) } : null;
            });

            if (mathExpr) {
                const res = mathExpr.op === '+' ? mathExpr.n1 + mathExpr.n2 : mathExpr.n1 - mathExpr.n2;
                console.log(`🧮 计算数学题: ${mathExpr.n1} ${mathExpr.op} ${mathExpr.n2} = ${res}`);
                const inputLoc = page.locator('input[type="number"], input[type="text"]').first();
                if (await inputLoc.isVisible()) await inputLoc.fill(String(res));
            }

            const continueBtn = page.locator('button:has-text("CONTINUE WITH LOGIN"), a:has-text("CONTINUE WITH LOGIN")').first();
            if (await continueBtn.isVisible().catch(() => false)) await continueBtn.click();
            await page.waitForTimeout(3000);
        }

        mainSiteOk = !page.url().includes('/login');
        console.log(mainSiteOk ? '✅ 主站保活成功！' : '⚠️ 主站未登录成功，继续进行 Panel 保活...');

        // ==================== 2. 控制台 (Panel) 保活 ====================
        console.log('🌐 [2/2] 开始控制台 (Panel) 保活...');
        await page.goto('https://panel.optiklink.net/auth/login', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        if (!page.url().includes('/auth/login')) {
            console.log('🎉 控制台已处于登录状态！');
            panelOk = true;
        } else {
            if (!panelUser || !panelPass) {
                throw new Error('未在环境变量 PANEL_ACCOUNT 中获取到有效的账号或密码');
            }

            console.log(`✏️ 填入 PANEL_ACCOUNT 绑定的账号: ${panelUser}`);
            await page.locator('input[name="username"]').fill(panelUser);
            await page.locator('input[name="password"]').fill(panelPass);

            console.log('📤 点击控制台登录...');
            await page.locator('button[type="submit"]').click();
            await page.waitForTimeout(3000);

            // 破解 reCAPTCHA 拦截
            await solveRecaptchaAudio(page);

            await page.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 25000 });
            panelOk = true;
            console.log('✅ 控制台登录成功！');
        }

        await sendTG(`✅ 保活成功！(主站: ${mainSiteOk ? '成功' : '跳过'}, Panel: ${panelOk ? '成功' : '失败'})`);

    } catch (e) {
        console.log(`❌ 执行失败: ${e.message}`);
        await sendTG(`❌ 保活失败: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
