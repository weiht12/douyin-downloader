const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const dy = require('./douyin.js');

const app = express();
const PORT = process.env.PORT || 3456;
// Render 免费版用 /tmp，付费版用挂载的磁盘，本地用项目目录
const DOWNLOADS_DIR = process.env.RENDER ? '/tmp/downloads' : path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

function listDownloads() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  return fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const p = path.join(DOWNLOADS_DIR, f);
      const stat = fs.statSync(p);
      return { name: f, size: stat.size, time: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.time - a.time);
}

async function parseUrl(body) {
  const { url } = body;
  if (!url) throw new Error('缺少 url 参数');
  const rawUrl = dy.extractUrl(url);
  const videoId = await dy.getVideoId(rawUrl);
  return dy.getVideoInfo(videoId);
}

// POST /api/parse - 解析视频信息
app.post('/api/parse', async (req, res) => {
  try {
    const raw = req.body.url || '';
    const cleaned = dy.extractUrl(raw);
    log('[parse] 原始:', raw.substring(0, 60), '| 清洗后:', cleaned);
    const info = await parseUrl(req.body);
    res.json({ title: info.title, thumbnail: info.coverUrl, video_id: info.videoId });
  } catch (err) {
    logError('[parse] 错误:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/download/video
app.post('/api/download/video', async (req, res) => {
  try {
    const info = await parseUrl(req.body);
    const safeName = dy.sanitize(info.title);
    const filename = safeName + '.mp4';
    const dest = path.join(DOWNLOADS_DIR, filename);
    await dy.httpDownload(info.playwmUrl, dest);
    res.json({ filename, size: fs.statSync(dest).size, downloads: listDownloads() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/download/cover
app.post('/api/download/cover', async (req, res) => {
  try {
    const info = await parseUrl(req.body);
    if (!info.coverUrl) throw new Error('未找到封面图片');
    const safeName = dy.sanitize(info.title);
    const filename = safeName + '_封面.jpg';
    const dest = path.join(DOWNLOADS_DIR, filename);
    await dy.httpDownload(info.coverUrl, dest);
    res.json({ filename, size: fs.statSync(dest).size, downloads: listDownloads() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/download/audio
app.post('/api/download/audio', async (req, res) => {
  try {
    const info = await parseUrl(req.body);
    const safeName = dy.sanitize(info.title);
    const filename = safeName + '_音频.mp4';
    const dest = path.join(DOWNLOADS_DIR, filename);
    await dy.httpDownload(info.playwmUrl, dest);
    res.json({ filename, size: fs.statSync(dest).size, downloads: listDownloads() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/downloads
app.get('/api/downloads', (req, res) => {
  res.json({ files: listDownloads() });
});

// DELETE /api/downloads/:filename
app.delete('/api/downloads/:filename', (req, res) => {
  const file = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '文件不存在' });
  fs.unlinkSync(file);
  res.json({ ok: true, downloads: listDownloads() });
});

function log(...args) {
  const msg = '[' + new Date().toISOString() + '] ' + args.join(' ');
  console.log(msg);
}
function logError(...args) {
  const msg = '[' + new Date().toISOString() + '] ERROR ' + args.join(' ');
  console.error(msg);
}

app.listen(PORT, () => {
  log(`抖音下载器运行中: http://localhost:${PORT}`);
});
