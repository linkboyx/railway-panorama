// HTTP 客户端：限速（可自适应）、重试、超时、Cookie、熔断（无第三方依赖，需 Node.js 18+）
import { sleep, jitter, warn, fmtDuration } from './util.mjs';

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message); this.status = status; this.url = url; this.body = body;
  }
}

function splitSetCookie(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  // 多个 Set-Cookie 被逗号拼接时，按“逗号后紧跟 name=”切分（避免切开 Expires 日期）
  return raw.split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
}

export class HttpClient {
  /**
   * @param {object} o
   * @param {string} o.name        日志名称
   * @param {number} o.minIntervalMs 两次请求之间的最小间隔（全局，所有并发共享）
   * @param {boolean} o.adaptive   自适应限速：连续失败时加大间隔（最多 maxIntervalMs），持续成功后逐步恢复到 minIntervalMs
   * @param {number} o.timeoutMs   单次请求超时
   * @param {number} o.retries     失败重试次数
   * @param {number} o.breakAfter  连续失败多少次后暂停
   * @param {number} o.breakMs     暂停时长；反复触发时逐次加倍，最长 breakMaxMs
   */
  constructor({
    name = 'http', minIntervalMs = 0, timeoutMs = 25000, retries = 4,
    breakAfter = 10, breakMs = 60000, breakMaxMs = 0, maxBreaks = 0, adaptive = false, maxIntervalMs = 10000,
    headers = {}, userAgent = DEFAULT_UA, verbose = false, retryStatuses = [],
  } = {}) {
    Object.assign(this, { name, minIntervalMs, timeoutMs, retries, breakAfter, breakMs, maxBreaks, verbose, retryStatuses, adaptive, maxIntervalMs });
    this.breakMaxMs = Math.max(breakMs, breakMaxMs);
    this.baseHeaders = { 'User-Agent': userAgent, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers };
    this.cookies = new Map(); // host -> Map(name -> value)
    this.gate = Promise.resolve();
    this.interval = minIntervalMs; // 当前请求间隔（自适应时会变化）
    this.consecutiveFailures = 0;
    this.okStreak = 0;
    this.floor = minIntervalMs;    // 被限流后记住的“安全间隔”：加快时不低于它，持续成功后再小心试探
    this.floorOkBlocks = 0;
    this.failStartInterval = 0;
    this.breakLevel = 0;
    this.breaksWithoutSuccess = 0;
    this.breaking = null;
    this.lastError = '';
    this.stats = { requests: 0, ok: 0, retries: 0, failures: 0, breaks: 0, bytes: 0 };
  }

  /** 当前大约每秒几次请求（未限速时返回 Infinity） */
  get rate() { return this.interval ? 1000 / this.interval : Infinity; }

  setCookie(host, name, value) {
    if (!this.cookies.has(host)) this.cookies.set(host, new Map());
    this.cookies.get(host).set(name, value);
  }
  cookieHeader(host) {
    const parts = [];
    for (const [h, jar] of this.cookies) {
      if (host === h || host.endsWith('.' + h)) for (const [k, v] of jar) parts.push(`${k}=${v}`);
    }
    return parts.join('; ');
  }
  clearCookies() { this.cookies.clear(); }

  async throttle() {
    if (!this.interval) return;
    const wait = this.gate.then(() => sleep(jitter(this.interval, 0.35)));
    this.gate = wait;
    await wait;
  }

  onSuccess() {
    this.consecutiveFailures = 0;
    this.breaksWithoutSuccess = 0;
    this.stats.ok++;
    if (!this.adaptive || ++this.okStreak < 20) return;
    // 连续成功 20 次：加快一点（不低于安全间隔），熔断等级也降一级
    this.okStreak = 0;
    const floor = Math.max(this.minIntervalMs, this.floor);
    if (this.interval > floor) this.interval = Math.max(floor, Math.floor(this.interval * 0.75));
    else if (this.floor > this.minIntervalMs && ++this.floorOkBlocks >= 10) {
      // 在安全间隔下又连续成功了约 200 次：小心地再加快一点
      this.floorOkBlocks = 0;
      this.floor = Math.max(this.minIntervalMs, Math.round(this.floor * 0.9));
    }
    if (this.breakLevel > 0) this.breakLevel--;
  }

  onFailure(err) {
    if (this.consecutiveFailures === 0) this.failStartInterval = this.interval;
    this.consecutiveFailures++;
    this.okStreak = 0;
    this.lastError = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 80);
    if (!this.adaptive) return;
    // 连续失败（限流的典型表现）才放慢；偶发的单次失败不影响速度
    if (this.consecutiveFailures % 3 === 0) this.interval = Math.min(this.maxIntervalMs, Math.max(300, Math.round(this.interval * 1.5)));
    // 连续失败 6 次：基本可以确定是限流，记住出问题时的速度，以后加快时不超过它
    if (this.consecutiveFailures === 6) this.raiseFloor(1.2);
  }

  /** 在开始连续失败时的速度下被限流了：以后的请求间隔不小于它的 factor 倍 */
  raiseFloor(factor) {
    this.floor = Math.min(this.maxIntervalMs, Math.max(this.floor, Math.round(Math.max(this.failStartInterval, 100) * factor)));
    this.floorOkBlocks = 0;
  }

  /** 连续失败过多时暂停（所有并发请求一起等，只提示一次）；反复触发时暂停时间逐次加倍 */
  async checkBreaker() {
    while (this.breaking) await this.breaking;
    if (this.consecutiveFailures < this.breakAfter) return;
    if (this.maxBreaks && this.breaksWithoutSuccess >= this.maxBreaks) {
      // 暂停了多次仍然一次都没成功：对方多半封禁了一段时间，停止运行，避免长时间无效请求
      throw Object.assign(new Error(`${this.name}: 连续暂停 ${this.breaksWithoutSuccess} 次后仍然全部失败（${this.lastError}），可能被暂时封禁`), { fatalBreak: true });
    }
    this.breaksWithoutSuccess++;
    const ms = Math.min(this.breakMaxMs, this.breakMs * 2 ** this.breakLevel);
    this.breakLevel++;
    this.stats.breaks++;
    if (this.adaptive) {
      this.raiseFloor(1.3);
      this.interval = Math.max(this.interval, this.floor);
    }
    warn(`${this.name}: 连续失败 ${this.consecutiveFailures} 次，可能被限流（${this.lastError}），暂停 ${fmtDuration(ms / 1000)}` +
      (this.adaptive ? `，之后放慢到约每 ${(this.interval / 1000).toFixed(1)} 秒一次请求` : '') + '…');
    this.breaking = (async () => {
      await sleep(ms);
      this.consecutiveFailures = Math.floor(this.breakAfter / 2);
      if (this.onBreak) { try { await this.onBreak(); } catch { /* 忽略 */ } }
    })();
    try { await this.breaking; } finally { this.breaking = null; }
  }

  /**
   * 发送请求。expect: 'text' | 'json' | 'buffer'
   * validate(result) 返回 true 表示有效；返回字符串表示无效原因（会重试）
   */
  async request(url, {
    method = 'GET', headers = {}, body, referer, expect = 'text', validate,
    retries = this.retries, timeoutMs = this.timeoutMs, retryOn4xx = false, retryStatuses = this.retryStatuses,
    bypassBreaker = false, // 熔断回调（onBreak）里发出的请求用，避免自己等自己
  } = {}) {
    const u = new URL(url);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!bypassBreaker) await this.checkBreaker();
      await this.throttle();
      this.stats.requests++;
      if (attempt > 0) this.stats.retries++;
      try {
        const h = { ...this.baseHeaders, ...headers };
        if (referer) h.Referer = referer;
        const ck = this.cookieHeader(u.hostname);
        if (ck) h.Cookie = ck;
        const res = await fetch(url, {
          method, headers: h, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
        });
        for (const sc of splitSetCookie(res.headers)) {
          const kv = sc.split(';')[0];
          const i = kv.indexOf('=');
          if (i > 0) this.setCookie(u.hostname, kv.slice(0, i).trim(), kv.slice(i + 1).trim());
        }
        const buf = Buffer.from(await res.arrayBuffer());
        this.stats.bytes += buf.length;
        if (res.status === 429 || res.status >= 500 || (retryOn4xx && res.status >= 400) || retryStatuses.includes(res.status)) {
          const ra = Number(res.headers.get('retry-after'));
          throw Object.assign(new HttpError(`HTTP ${res.status}`, { status: res.status, url, body: buf.toString('utf8', 0, 300) }),
            { retryAfter: isFinite(ra) && ra > 0 ? ra * 1000 : 0 });
        }
        if (res.status >= 400) {
          this.consecutiveFailures = 0;
          throw Object.assign(new HttpError(`HTTP ${res.status}`, { status: res.status, url, body: buf.toString('utf8', 0, 300) }), { fatal: true });
        }
        let result;
        if (expect === 'buffer') result = buf;
        else {
          const text = buf.toString('utf8');
          if (expect === 'json') {
            try { result = JSON.parse(text); } catch {
              const snippet = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
              throw new HttpError(`返回的不是 JSON（可能被限流或需要验证）：${snippet}`, { status: res.status, url, body: text.slice(0, 500) });
            }
          } else result = text;
        }
        if (validate) {
          const v = validate(result);
          if (v !== true) throw new HttpError(`返回内容无效：${v || '校验失败'}`, { status: res.status, url });
        }
        // 熔断回调里的请求（bypassBreaker）不计入限流统计：否则被封期间一个能打开的页面就会让熔断计数清零
        if (bypassBreaker) this.stats.ok++; else this.onSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (err.fatal) break;
        if (!bypassBreaker) this.onFailure(err);
        if (attempt < retries) {
          const backoff = err.retryAfter || Math.min(60000, 1500 * 2 ** attempt);
          if (this.verbose) warn(`${this.name}: ${err.message} → ${Math.round(backoff / 1000)}s 后重试 (${attempt + 1}/${retries}) ${url}`);
          await sleep(jitter(backoff, 0.25));
        }
      }
    }
    this.stats.failures++;
    throw lastErr;
  }

  getText(url, opts) { return this.request(url, { ...opts, expect: 'text' }); }
  getJSON(url, opts) { return this.request(url, { ...opts, expect: 'json' }); }
}
