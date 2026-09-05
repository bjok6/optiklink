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

        const body = JSON.stringify({
            chat_id: TG_CHAT_ID,
            text: msg
        });

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
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


/**
 * 处理进入服务器面板前的 Quick Verification
 *
 * 注意：
 * 这个验证不是 Discord 登录验证。
 * 正确位置是在：
 *
 * Login to Panel
 *       ↓
 * Quick Verification
 *       ↓
 * Panel Login
 */
async function handleQuickVerification(page) {
    console.log('🔍 检查 OptikLink Panel Quick Verification...');

    try {
        // 给验证页面一点时间加载
        await page.waitForTimeout(1000);

        const bodyText = await page.locator('body').innerText().catch(() => '');

        // 没有 Quick Verification，直接继续
        if (!/Quick Verification|What\s+is/i.test(bodyText)) {
            console.log('✅ 未检测到 Quick Verification');
            return;
        }

        console.log('🧮 检测到 Quick Verification');

        /*
         * 支持：
         *
         * What is 3 + 2 ?
         * What is 9 + 2 ?
         * What is 12 - 5 ?
         * What is 6 * 3 ?
         * What is 6 × 3 ?
         * What is 20 / 4 ?
         * What is 20 ÷ 4 ?
         */

        const match = bodyText.match(
            /What\s+is\s*(-?\d+(?:\.\d+)?)\s*([+\-*/×÷xX])\s*(-?\d+(?:\.\d+)?)\s*\?/i
        );

        if (!match) {
            throw new Error(
                '检测到 Quick Verification，但无法识别数学题'
            );
        }

        const a = Number(match[1]);
        const op = match[2];
        const b = Number(match[3]);

        let answer;

        switch (op) {
            case '+':
                answer = a + b;
                break;

            case '-':
                answer = a - b;
                break;

            case '*':
            case '×':
            case 'x':
            case 'X':
                answer = a * b;
                break;

            case '/':
            case '÷':
                if (b === 0) {
                    throw new Error('除数不能为 0');
                }
                answer = a / b;
                break;

            default:
                throw new Error(`不支持的运算符：${op}`);
        }

        // 避免出现 5.0000000001 之类的浮点尾数
        if (Number.isInteger(answer)) {
            answer = String(answer);
        } else {
            answer = String(Number(answer.toFixed(10)));
        }

        console.log(`🧮 数学题：${a} ${op} ${b} = ${answer}`);

        // 截图中的输入框是 input[type="number"]
        const input = page.locator(
            'input[type="number"], ' +
            'input[name*="answer" i], ' +
            'input[placeholder*="answer" i]'
        ).first();

        await input.waitFor({
            state: 'visible',
            timeout: 10000
        });

        await input.fill(answer);

        console.log(`📤 已填写答案：${answer}`);

        const continueBtn = page.getByRole('button', {
            name: /CONTINUE\s+WITH\s+LOGIN/i
        }).first();

        await continueBtn.waitFor({
            state: 'visible',
            timeout: 10000
        });

        await continueBtn.click();

        console.log('📤 已点击 CONTINUE WITH LOGIN');

        // 等待验证处理
        await page.waitForTimeout(1500);

        const currentUrl = page.url();

        const afterText = await page
            .locator('body')
            .innerText()
            .catch(() => '');

        if (
            /Quick Verification|What\s+is/i.test(afterText) &&
            currentUrl.includes('optiklink')
        ) {
            throw new Error(
                '数学验证提交后页面仍停留在 Quick Verification'
            );
        }

        console.log(
            `✅ Quick Verification 处理完成，当前：${currentUrl}`
        );

    } catch (e) {
        throw new Error(
            `Quick Verification 处理失败：${e.message}`
        );
    }
}


/**
 * Discord 登录
 */
async function handleDiscordLogin(page, email, password) {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);

    await page.click('button[type="submit"]');

    try {
        await page.waitForURL(
            url => !url.toString().includes('discord.com/login'),
            {
                timeout: 15000
            }
        );
    } catch {
        let err = '账密错误或触发了 2FA / 验证码';

        try {
            err = await page
                .locator('[class*="errorMessage"]')
                .first()
                .innerText();
        } catch {}

        throw new Error(`❌ Discord 登录失败: ${err}`);
    }
}


/**
 * Discord OAuth 授权
 */
async function handleOAuthPage(page) {
    await page.waitForTimeout(2000);

    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) {
            return;
        }

        try {
            const btn = await page.waitForSelector(
                'button.primary_a22cb0',
                {
                    timeout: 3000
                }
            );

            const text = (await btn.innerText()).trim();

            if (/scroll/i.test(text) || text.includes('滚动')) {

                await page.evaluate(() => {
                    const s =
                        document.querySelector('[class*="scroller"]') ||
                        document.querySelector('[class*="scrollerBase"]') ||
                        document.querySelector('[class*="content"]');

                    if (s) {
                        s.scrollTop = s.scrollHeight;
                    }

                    window.scrollTo(
                        0,
                        document.body.scrollHeight
                    );
                });

                await page.waitForTimeout(1500);

                await btn.click();

                await page.waitForTimeout(1500);

            } else if (
                /authorize/i.test(text) ||
                text.includes('授权')
            ) {

                await btn.click();

                await page.waitForTimeout(3000);

                return;

            } else {
                await page.waitForTimeout(1500);
            }

        } catch {
            try {
                await page.waitForURL(
                    url => !url.toString().includes('discord.com'),
                    {
                        timeout: 10000
                    }
                );
            } catch {
                // 继续等待
            }

            return;
        }
    }
}


test('OptikLink 保活', async ({ }, testInfo) => {

    const proxyUrl = '';

    if (!email || !password) {
        throw new Error(
            '❌ 缺少账号配置，格式: DISCORD_ACCOUNT=email,password'
        );
    }

    let proxyConfig = undefined;

    /*
     * GOST 本地代理
     */
    if (process.env.GOST_PROXY) {

        try {

            const http = require('http');

            await new Promise((resolve, reject) => {

                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port: 8080,
                        path: '/',
                        method: 'GET',
                        timeout: 3000
                    },
                    () => resolve()
                );

                req.on('error', reject);

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('timeout'));
                });

                req.end();
            });

            proxyConfig = {
                server: process.env.GOST_PROXY
            };

            console.log(
                '🛡️ 本地代理连通，使用 GOST 转发'
            );

        } catch {
            console.log(
                '⚠️ 本地代理不可达，降级为直连'
            );
        }

    } else if (proxyUrl) {

        proxyConfig = {
            server: proxyUrl
        };

        console.log(
            `🛡️ 使用代理: ${proxyUrl.replace(
                /:\/\/.*@/,
                '://***@'
            )}`
        );
    }


    /*
     * 启动浏览器
     */
    console.log('🔧 启动浏览器...');

    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });

    const page = await browser.newPage();

    page.setDefaultTimeout(TIMEOUT);

    let activePage = page;


    /*
     * 广告拦截
     *
     * 注意：
     * 不再拦截 optiklink.com
     * 因为 OAuth 回调会使用 optiklink.com/login
     */
    await page.addInitScript(() => {

        if (!location.hostname.includes('optiklink.net')) {
            return;
        }

        const AD_DOMAINS = [
            'tzegilo.com',
            'alwingulla.com',
            'auqot.com',
            'jmosl.com',
            '094kk.com',

            'tmll7.com',
            'oundhertobeconsist.org',

            'pagead2.googlesyndication.com',
            'googlesyndication.com',
            'googletagservices.com',
            'doubleclick.net',

            'adsbygoogle',
            'popads',
            'popcash',
            'clickadu',
            'tsyndicate',
            'trafficjunky',
            'afu.php',
        ];

        const isAd = (url) =>
            url &&
            AD_DOMAINS.some(d => url.includes(d));


        /*
         * script
         */
        const _createElement =
            document.createElement.bind(document);

        document.createElement = function (tag) {

            const el = _createElement(tag);

            if (tag.toLowerCase() === 'script') {

                const _desc =
                    Object.getOwnPropertyDescriptor(
                        HTMLScriptElement.prototype,
                        'src'
                    );

                Object.defineProperty(el, 'src', {

                    set(val) {
                        if (!isAd(val)) {
                            _desc.set.call(this, val);
                        }
                    },

                    get() {
                        return _desc.get.call(this);
                    },

                });
            }

            return el;
        };


        /*
         * document.write
         */
        const _write =
            document.write.bind(document);

        document.write = function (html) {

            if (!isAd(html)) {
                return _write(html);
            }
        };


        /*
         * appendChild
         */
        const _appendChild =
            Element.prototype.appendChild;

        Element.prototype.appendChild =
            function (node) {

                if (
                    node?.tagName === 'SCRIPT' &&
                    isAd(node.src)
                ) {
                    return node;
                }

                return _appendChild.call(
                    this,
                    node
                );
            };


        /*
         * insertBefore
         */
        const _insertBefore =
            Element.prototype.insertBefore;

        Element.prototype.insertBefore =
            function (node, ref) {

                if (
                    node?.tagName === 'SCRIPT' &&
                    isAd(node.src)
                ) {
                    return node;
                }

                return _insertBefore.call(
                    this,
                    node,
                    ref
                );
            };


        /*
         * fetch
         */
        const _fetch = window.fetch;

        window.fetch = function (url, ...args) {

            if (
                isAd(
                    typeof url === 'string'
                        ? url
                        : url?.url
                )
            ) {
                return Promise.reject(
                    new Error('blocked')
                );
            }

            return _fetch.call(
                this,
                url,
                ...args
            );
        };


        /*
         * XMLHttpRequest
         */
        const _xhrOpen =
            XMLHttpRequest.prototype.open;

        XMLHttpRequest.prototype.open =
            function (method, url, ...args) {

                if (isAd(url)) {
                    return;
                }

                return _xhrOpen.call(
                    this,
                    method,
                    url,
                    ...args
                );
            };


        /*
         * window.open
         */
        const _open =
            window.open.bind(window);

        window.open = function (url, ...args) {

            if (!url) {
                return null;
            }

            if (
                url.startsWith('/') ||
                url.includes('optiklink.net') ||
                url.includes('optiklink.com')
            ) {
                return _open(url, ...args);
            }

            return null;
        };


        /*
         * click 事件
         */
        const _addEL =
            EventTarget.prototype.addEventListener;

        EventTarget.prototype.addEventListener =
            function (type, fn, opts) {

                if (
                    type === 'click' &&
                    (this === window || this === document)
                ) {

                    const src =
                        fn?.toString() || '';

                    if (
                        /setTimeout\s*\(\s*\w\s*,\s*0\s*\)/
                            .test(src)
                    ) {
                        return;
                    }

                    if (
                        /contextmenu.*localStorage|localStorage.*contextmenu/s
                            .test(src)
                    ) {
                        return;
                    }
                }

                return _addEL.call(
                    this,
                    type,
                    fn,
                    opts
                );
            };


        /*
         * adsbygoogle
         */
        Object.defineProperty(
            window,
            'adsbygoogle',
            {
                get: () => ({
                    loaded: true,
                    push: () => {}
                }),

                set: () => {},

                configurable: false,
            }
        );

    });


    console.log('🚀 浏览器就绪！');
    console.log('🛡️ OptikLink 广告猎手启动');


    try {

        /*
         * 验证出口 IP
         */
        console.log('🌐 验证出口 IP...');

        try {

            const res = await page.goto(
                'https://api.ipify.org?format=json',
                {
                    waitUntil: 'domcontentloaded'
                }
            );

            const body = await res.text();

            const ip =
                JSON.parse(body).ip || body;

            const masked =
                ip.replace(
                    /(\d+\.\d+\.\d+\.)\d+/,
                    '$1xx'
                );

            console.log(
                `✅ 出口 IP 确认：${masked}`
            );

        } catch {
            console.log(
                '⚠️ IP 验证超时，跳过'
            );
        }


        /*
         * OptikLink 登录
         */
        console.log(
            '🔑 打开 OptikLink 登录页...'
        );

        await page.goto(
            'https://optiklink.com/auth',
            {
                waitUntil: 'domcontentloaded'
            }
        );

        // optiklink.com 会自动跳转到 optiklink.net
        // Quick Verification 不在这里处理


        /*
         * Discord 登录
         */
        console.log(
            '📤 点击 Login with Discord...'
        );

        await page.click(
            "a[href='login']"
        );


        console.log(
            '⏳ 等待跳转 Discord 登录页...'
        );

        await page.waitForURL(
            url =>
                !url
                    .toString()
                    .includes(
                        'optiklink.com/auth'
                    ),
            {
                timeout: TIMEOUT
            }
        );


        const landedUrl = page.url();


        /*
         * Discord 登录页
         */
        if (
            landedUrl.includes(
                'discord.com/login'
            )
        ) {

            console.log(
                '✏️ 填写账号密码...'
            );

            await page.fill(
                'input[name="email"]',
                email
            );

            await page.fill(
                'input[name="password"]',
                password
            );

            console.log(
                '📤 提交登录请求...'
            );

            await page.click(
                'button[type="submit"]'
            );

            try {

                await page.waitForURL(
                    url =>
                        !url
                            .toString()
                            .includes(
                                'discord.com/login'
                            ),
                    {
                        timeout: 15000
                    }
                );

            } catch {

                let err =
                    '账密错误或触发了 2FA / 验证码';

                try {

                    err =
                        await page
                            .locator(
                                '[class*="errorMessage"]'
                            )
                            .first()
                            .innerText();

                } catch {}

                await sendTG(
                    `❌ Discord 登录失败：${err}`
                );

                throw new Error(
                    `❌ Discord 登录失败: ${err}`
                );
            }


        } else if (
            landedUrl.includes(
                'discord.com/oauth2'
            )
        ) {

            /*
             * OAuth 页面
             */
            try {

                const btn =
                    await page.waitForSelector(
                        'button.primary_a22cb0',
                        {
                            timeout: 5000
                        }
                    );

                const btnText =
                    (await btn.innerText()).trim();

                if (
                    /log\s*in/i.test(btnText) ||
                    btnText.includes('登录')
                ) {

                    console.log(
                        '✏️ 填写账号密码...'
                    );

                    await btn.click();

                    await page.waitForURL(
                        /discord\.com\/login/,
                        {
                            timeout: 10000
                        }
                    );

                    await page.fill(
                        'input[name="email"]',
                        email
                    );

                    await page.fill(
                        'input[name="password"]',
                        password
                    );

                    console.log(
                        '📤 提交登录请求...'
                    );

                    await page.click(
                        'button[type="submit"]'
                    );

                    try {

                        await page.waitForURL(
                            url =>
                                !url
                                    .toString()
                                    .includes(
                                        'discord.com/login'
                                    ),
                            {
                                timeout: 15000
                            }
                        );

                    } catch {

                        let err =
                            '账密错误或触发了 2FA / 验证码';

                        try {

                            err =
                                await page
                                    .locator(
                                        '[class*="errorMessage"]'
                                    )
                                    .first()
                                    .innerText();

                        } catch {}

                        await sendTG(
                            `❌ Discord 登录失败：${err}`
                        );

                        throw new Error(
                            `❌ Discord 登录失败: ${err}`
                        );
                    }
                }

            } catch (e) {

                if (
                    e.message.includes(
                        'Discord 登录失败'
                    )
                ) {
                    throw e;
                }

                // 找不到按钮说明可能已经登录
            }
        }


        /*
         * OAuth 授权
         */
        console.log(
            '⏳ 等待 OAuth 授权...'
        );

        try {

            await page.waitForURL(
                /discord\.com\/oauth2\/authorize/,
                {
                    timeout: 6000
                }
            );

            console.log(
                '🔍 进入 Discord OAuth 授权页，处理中...'
            );

            console.log(
                '  📄 当前在 Discord 授权页面'
            );

            await handleOAuthPage(page);

            console.log(
                '  ✨ 已授权，等待自动跳转...'
            );

            try {

                await page.waitForURL(
                    /optiklink\.net/,
                    {
                        timeout: 15000
                    }
                );

                console.log(
                    '  ⏳ 跳转中，稍候...'
                );

            } catch {
                // 继续
            }

            console.log(
                `✅ 已离开 Discord，当前：${page.url()}`
            );

        } catch (e) {

            if (
                e.message.includes(
                    'Discord 登录失败'
                )
            ) {
                throw e;
            }
        }


        /*
         * OAuth 后如果又回到 Discord 登录页
         */
        if (
            page.url().includes(
                'discord.com/login'
            )
        ) {

            console.log(
                '🔄 OAuth 后被重定向至登录页，再次填写账号密码...'
            );

            await page.fill(
                'input[name="email"]',
                email
            );

            await page.fill(
                'input[name="password"]',
                password
            );

            console.log(
                '📤 提交登录请求...'
            );

            await page.click(
                'button[type="submit"]'
            );

            try {

                await page.waitForURL(
                    url =>
                        !url
                            .toString()
                            .includes(
                                'discord.com/login'
                            ),
                    {
                        timeout: 20000
                    }
                );

                console.log(
                    `✅ 二次登录后跳转至：${page.url()}`
                );

            } catch {

                let err =
                    '账密错误或触发了 2FA / 验证码';

                try {

                    err =
                        await page
                            .locator(
                                '[class*="errorMessage"]'
                            )
                            .first()
                            .innerText();

                } catch {}

                await sendTG(
                    `❌ Discord 二次登录失败：${err}`
                );

                throw new Error(
                    `❌ Discord 二次登录失败: ${err}`
                );
            }


            /*
             * 二次登录后再次 OAuth
             */
            if (
                page.url().includes(
                    'discord.com/oauth2'
                )
            ) {

                console.log(
                    '🔍 二次进入 OAuth 授权页，处理中...'
                );

                await handleOAuthPage(page);

                try {

                    await page.waitForURL(
                        /optiklink\.net/,
                        {
                            timeout: 15000
                        }
                    );

                } catch {
                    // 继续
                }

                console.log(
                    `✅ OAuth 二次处理完成，当前：${page.url()}`
                );
            }
        }


        /*
         * 确认真正进入 OptikLink 首页
         *
         * 不能使用 /optiklink.net
         * 因为 /login 也会匹配
         */
        console.log(
            '⏳ 确认到达 OptikLink...'
        );

try {
    await page.waitForURL(
        /optiklink\.net/,
        {
            timeout: 30000
        }
    );
} catch {
    // 继续
}

if (!page.url().includes('optiklink.net')) {
    throw new Error(
        `❌ OAuth 后未到达 OptikLink，当前 URL: ${page.url()}`
    );
}

console.log(
    `✅ 登录成功！当前: ${page.url()}`
);


        /*
         * Login to Panel
         */
        console.log(
            '📤 点击 Login to Panel...'
        );

        const loginToPanel =
            page.locator(
                'a[data-target="#logintopanel"], ' +
                'a:has-text("Login to Panel"), ' +
                'button:has-text("Login to Panel")'
            ).first();

        await loginToPanel.waitFor({
            state: 'visible',
            timeout: TIMEOUT
        });

        await loginToPanel.click();


        /*
         * ⭐ Quick Verification 正确位置
         *
         * Login to Panel
         *       ↓
         * Quick Verification
         *       ↓
         * Panel Login
         */
        console.log(
            '🔍 检查 Panel Quick Verification...'
        );

        await handleQuickVerification(page);

        await page.waitForTimeout(1000);


        /*
         * Panel Login
         */
        console.log(
            '📤 点击 Panel Login...'
        );

        const panelLoginBtn =
            page.getByRole(
                'button',
                {
                    name: 'Panel Login'
                }
            );

        await panelLoginBtn.waitFor({
            state: 'visible'
        });


        /*
         * 打开控制台页面
         */
        const [panelPage] =
            await Promise.all([

                page.context()
                    .waitForEvent('page'),

                panelLoginBtn.click(),

            ]);


        panelPage.setDefaultTimeout(
            TIMEOUT
        );

        activePage = panelPage;


        console.log(
            '⏳ 等待控制台页面加载...'
        );

        await panelPage.waitForURL(
            /control\.optiklink\.net/,
            {
                timeout: TIMEOUT,
                waitUntil: 'domcontentloaded'
            }
        );


        const currentUrl =
            panelPage.url();

        console.log(
            `✅ 已到达控制台页面：${currentUrl}`
        );


        /*
         * 控制台登录
         */
        if (
            currentUrl.includes(
                '/auth/login'
            )
        ) {

            console.log(
                '✏️ 填写控制台账号密码...'
            );

            await panelPage.fill(
                'input[name="username"]',
                panelUser
            );

            await panelPage.fill(
                'input[name="password"]',
                panelPass
            );


            /*
             * reCAPTCHA
             */
            console.log(
                '⏳ 等待 reCAPTCHA 加载...'
            );

            await panelPage.waitForFunction(
                () => {
                    return (
                        typeof grecaptcha !== 'undefined' &&
                        grecaptcha.getResponse !== undefined
                    );
                },
                {
                    timeout: 15000
                }
            ).catch(() => {

                console.log(
                    '  ℹ️ reCAPTCHA 未检测到，继续...'
                );

            });

            await panelPage.waitForTimeout(
                2000
            );


            console.log(
                '📤 提交控制台登录...'
            );

            await panelPage.click(
                'button[type="submit"]'
            );


            console.log(
                '⏳ 确认到达控制台首页...'
            );

            await panelPage.waitForURL(
                url =>
                    !url
                        .toString()
                        .includes(
                            '/auth/login'
                        ),
                {
                    timeout: TIMEOUT,
                    waitUntil: 'domcontentloaded'
                }
            );

            console.log(
                `✅ 控制台登录成功！当前：${panelPage.url()}`
            );

        } else {

            console.log(
                'ℹ️ 检测到已不在登录页，可能已自动鉴权并跳转至首页...'
            );
        }


        await panelPage.waitForTimeout(
            2000
        );


        /*
         * 查找服务器
         */
        console.log(
            '🔍 查找服务器...'
        );

        await panelPage.waitForTimeout(
            2000
        );


        const serverInfo =
            await panelPage.evaluate(() => {

                const card =
                    document.querySelector(
                        'a[href*="/server/"]'
                    );

                if (!card) {
                    return null;
                }

                const href =
                    card.getAttribute('href');

                const id =
                    href
                        .replace('/server/', '')
                        .trim();

                const nameEl =
                    card.querySelector(
                        'p.sc-1ibsw91-5'
                    );

                const name =
                    nameEl
                        ? nameEl.innerText.trim()
                        : '';

                return {
                    id,
                    name
                };
            });


        if (!serverInfo) {
            throw new Error(
                '❌ 未找到服务器卡片'
            );
        }


        console.log(
            `✅ 找到服务器：${serverInfo.name} (${serverInfo.id})`
        );


        /*
         * 进入服务器页面
         */
        await panelPage.goto(
            `https://control.optiklink.net/server/${serverInfo.id}`,
            {
                waitUntil: 'domcontentloaded'
            }
        );

        console.log(
            `✅ 已到达服务器页面：${panelPage.url()}`
        );


        const serverPage =
            panelPage;


        /*
         * 检查服务器状态
         */
        console.log(
            '🔍 检查服务器状态...'
        );

        await serverPage.waitForTimeout(
            3000
        );


        let statusText = '';


        /*
         * 等待状态稳定
         */
        for (let i = 0; i < 12; i++) {

            statusText =
                await serverPage
                    .locator(
                        'p.sc-168cvuh-1'
                    )
                    .innerText()
                    .catch(() => '');

            const s =
                statusText.toLowerCase();

            if (
                s.includes('running') ||
                s.includes('offline') ||
                s.includes('stopped')
            ) {
                break;
            }

            console.log(
                `  🔄 等待状态稳定（${statusText.trim()}）...`
            );

            await serverPage.waitForTimeout(
                5000
            );
        }


        console.log(
            `💻 服务器状态：${statusText.trim()}`
        );


        /*
         * Running
         */
        if (
            statusText
                .toLowerCase()
                .includes('running')
        ) {

            console.log(
                '🎉 保活成功！'
            );

            await sendTG(
                '✅ 保活成功！\n💻 服务器状态：🚀 Running',
                serverInfo.name
            );


        /*
         * Offline / Stopped
         */
        } else if (
            statusText
                .toLowerCase()
                .includes('offline') ||
            statusText
                .toLowerCase()
                .includes('stopped')
        ) {

            console.log(
                '⚠️ 服务器离线，尝试启动...'
            );

            await serverPage.click(
                'button:has-text("Start")'
            );

            console.log(
                '📤 已点击 Start，持续监控状态...'
            );


            let started = false;


            for (let i = 0; i < 24; i++) {

                await serverPage.waitForTimeout(
                    5000
                );

                const s =
                    await serverPage
                        .locator(
                            'p.sc-168cvuh-1'
                        )
                        .innerText()
                        .catch(() => '');

                console.log(
                    `  🔄 第 ${i + 1} 次检查，状态：${s.trim()}`
                );


                if (
                    s
                        .toLowerCase()
                        .includes('running')
                ) {

                    started = true;

                    break;
                }
            }


            if (started) {

                console.log(
                    '✅ 服务器已成功启动！'
                );

                await sendTG(
                    '🔄 Start 启动！\n💻 服务器状态：🚀 Running',
                    serverInfo.name
                );

            } else {

                console.log(
                    '❌ 等待超时，服务器未能启动'
                );

                await sendTG(
                    '❌ Start 启动失败，等待超时\n💻 服务器状态：💤 Offline',
                    serverInfo.name
                );
            }


        /*
         * Unknown
         */
        } else {

            console.log(
                `⚠️ 未知状态：${statusText.trim()}`
            );

            await sendTG(
                `⚠️ 状态未知\n💻 服务器状态：❓ ${statusText.trim()}`,
                serverInfo.name
            );
        }


    } catch (e) {

        try {

            const screenshotPath =
                testInfo.outputPath(
                    'failure.png'
                );

            await activePage.screenshot({
                path: screenshotPath,
                fullPage: true
            });

            await testInfo.attach(
                'failure',
                {
                    path: screenshotPath,
                    contentType: 'image/png'
                }
            );

            console.log(
                '📸 失败截图已保存'
            );

        } catch {
            // 截图失败不影响主流程
        }


        await sendTG(
            `❌ 脚本异常：${e.message}`
        );

        throw e;


    } finally {

        await browser.close();

    }
});
