/**
 * 抖音视频下载 - 纯Node.js实现，无需Cookie
 * 策略：手机UA访问iesdouyin页面 → 提取play_addr URL → 重定向到CDN下载
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// 关键：手机端User-Agent（多个备用）
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
];

let _uaIdx = 0;
function mobileUA() {
  return USER_AGENTS[_uaIdx % USER_AGENTS.length];
}
function nextUA() {
  _uaIdx++;
}

function httpGet(url, options = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 10) { reject(new Error('重定向次数过多')); return; }

    const lib = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': mobileUA(),
      'Referer': 'https://www.douyin.com/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(options.headers || {})
    };

    lib.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location;
        // 处理相对路径重定向
        if (loc.startsWith('/')) {
          const u = new URL(url);
          loc = u.protocol + '//' + u.host + loc;
        } else if (!loc.startsWith('http')) {
          const u = new URL(url);
          loc = u.protocol + '//' + u.host + '/' + loc;
        }
        resolve(httpGet(loc, options, depth + 1));
        return;
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body, url });
      });
    }).on('error', reject).setTimeout(30000, function() {
      this.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function httpDownload(url, destPath, referer = 'https://www.douyin.com/') {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;

    const req = lib.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': mobileUA(),
        'Referer': referer,
      }
    }, (res) => {
      // 如果是重定向，跟随（支持多次）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = `${urlObj.protocol}//${urlObj.host}${loc}`;
        else if (!loc.startsWith('http')) loc = `${urlObj.protocol}//${urlObj.host}/${loc}`;
        resolve(httpDownload(loc, destPath, referer));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}（视频可能已下架或私密）`));
        return;
      }

      const ws = fs.createWriteStream(destPath);
      let total = 0;
      res.on('data', chunk => { total += chunk.length; });
      res.pipe(ws);
      ws.on('finish', () => resolve(total));
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('下载超时（3分钟）')); });
  });
}

function extractUrl(text) {
  // 简单可靠：从 http:// 或 https:// 开始，取到第一个空白字符为止
  const m = text.match(/(https?:\/\/[^\s"'"'<>【】\[\]（）\(\)]+)/);
  if (!m) return text.trim();

  let url = m[1];
  // 去除尾部标点符号、斜杠、反斜杠
  url = url.replace(/[，。！？、；:;,。.!?"'"'<>【】\[\]（）\(\)\/\\]+$/, '');
  return url.trim();
}

function getVideoId(url) {
  const patterns = [
    /\/video\/(\d{15,21})/,
    /\/share\/video\/(\d{15,21})/,
    /aweme\/(\d{15,21})/i,
  ];

  for (const p of patterns) {
    const m = url.match(p);
    if (m) return Promise.resolve(m[1]);
  }

  // 短链，展开
  return httpGet(url).then(r => {
    const finalUrl = (r.url || url).split('?')[0]; // 去掉查询参数
    for (const p of patterns) {
      const m = finalUrl.match(p);
      if (m) return m[1];
    }
    throw new Error('无法识别该链接，请确认是有效的抖音分享链接');
  });
}

function decodeUnicode(s) {
  return s
    .replace(/\u002F/g, '/').replace(/\u003D/g, '=')
    .replace(/\u0026/g, '&').replace(/\u003F/g, '?')
    .replace(/\u002C/g, ',');
}

async function getVideoInfo(videoId) {
  const shareUrls = [
    `https://www.iesdouyin.com/share/video/${videoId}/`,
    `https://v.douyin.com/${videoId}/`,
  ];

  let lastError = null;

  for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
    if (attempt > 0) nextUA(); // 换UA重试

    for (const shareUrl of shareUrls) {
      try {
        const r = await httpGet(shareUrl, {}, 0);
        const html = r.body;
        const htmlU = decodeUnicode(html);

        // 标题
        let title = '抖音视频';
        const titleM = htmlU.match(/"desc":"([^"]+)"/);
        if (titleM) title = titleM[1].trim();

        // 视频URI
        let videoUri = '';
        const uriM = htmlU.match(/"uri":"(v\d+[a-zA-Z0-9]+)"/);
        if (uriM) videoUri = uriM[1];

        // play_addr URL（多策略提取）
        let playwmUrl = '';

        // 策略1：直接提取 uri 拼装
        if (!playwmUrl && uriM) {
          playwmUrl = `https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${uriM[1]}&ratio=720p&line=0`;
        }

        // 策略2：从 play_addr.url_list 提取
        if (!playwmUrl) {
          const urlListM = htmlU.match(/"play_addr"[^}]{0,500}"url_list"\s*:\s*\[?"([^"\]]+)"\]?/s);
          if (urlListM) playwmUrl = urlListM[1].replace(/^["']|["']$/g, '');
        }

        // 策略3：从 playwm URL 提取
        if (!playwmUrl) {
          const playwmM = htmlU.match(/(https?:\/\/aweme\.snssdk\.com\/aweme\/v\d+\/playwm\/[^"'\s\\]+)/);
          if (playwmM) playwmUrl = playwmM[1];
        }

        // 策略4：从 play 拼装（无水印）
        if (!playwmUrl && uriM) {
          playwmUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uriM[1]}&ratio=720p&line=0`;
        }

        // 封面URL
        let coverUrl = '';
        const coverM = html.match(/(https?:\/\/p\d+-sign\.douyinpic\.com\/[^"'\s\\]+(?:webp|jpg|png)(?:\?[^"']*)?)/);
        if (coverM) {
          coverUrl = coverM[1].replace(/&amp;/g, '&');
        }
        // 备用封面策略
        if (!coverUrl) {
          const coverM2 = htmlU.match(/(https?:\/\/[^\s\\]+\.douyinpic\.com\/[^\s"']+\.(?:webp|jpg|png)(?:\?[^"']*)?)/);
          if (coverM2) coverUrl = coverM2[1].replace(/&amp;/g, '&');
        }

        if (!playwmUrl) {
          lastError = new Error('无法解析视频（可能私密/已下架/账号异常），请尝试其他视频');
          continue;
        }

        return { title, coverUrl, playwmUrl, videoUri, videoId };
      } catch (e) {
        lastError = e;
        continue;
      }
    }
  }

  throw lastError || new Error('解析失败，请稍后重试');
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
}

module.exports = { getVideoInfo, getVideoId, extractUrl, httpDownload, sanitize };

// CLI
if (require.main === module) {
  const action = process.argv[2] || 'info';
  const input = process.argv[3] || '';

  const DOWNLOADS = path.join(__dirname, 'downloads');
  if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS, { recursive: true });

  (async () => {
    try {
      const rawUrl = extractUrl(input);
      const videoId = await getVideoId(rawUrl);
      const info = await getVideoInfo(videoId);

      if (action === 'info') {
        console.log(JSON.stringify({
          title: info.title,
          uploader: '',
          thumbnail: info.coverUrl,
          video_id: videoId,
        }, null, 2));
        return;
      }

      const safeName = sanitize(info.title);

      if (action === 'video') {
        const dest = path.join(DOWNLOADS, safeName + '.mp4');
        const size = await httpDownload(info.playwmUrl, dest);
        console.log(JSON.stringify({ filename: path.basename(dest), size }));
      } else if (action === 'cover') {
        if (!info.coverUrl) throw new Error('未找到封面');
        const dest = path.join(DOWNLOADS, safeName + '_封面.jpg');
        const size = await httpDownload(info.coverUrl, dest);
        console.log(JSON.stringify({ filename: path.basename(dest), size }));
      } else if (action === 'audio') {
        // 提取音频：下载playwm后用ffmpeg提取（如果有ffmpeg）
        // 否则保存为mp4（视频文件，实际是音频）
        const dest = path.join(DOWNLOADS, safeName + '_音频.mp4');
        const size = await httpDownload(info.playwmUrl, dest);
        console.log(JSON.stringify({ filename: path.basename(dest), size, note: '已保存为视频格式，可在播放器中提取音频轨道' }));
      }
    } catch (e) {
      console.error(JSON.stringify({ error: e.message }));
      process.exit(1);
    }
  })();
}
