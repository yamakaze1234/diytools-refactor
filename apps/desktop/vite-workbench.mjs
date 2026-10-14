/** 开发预览适配：默认只读访问隔离数据；仅显式开启审阅后端时才转发到独立 Rust 测试进程。 */
// A read-only full-data browser preview. Desktop writes use the Rust command API.
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultAssetRoot = path.join(project, 'sandbox/workbench-assets');
/** 创建 Vite 中间件，提供本机数据与受限素材访问；性能探针仅在开发环境显式启用。 */
export function workbenchPreview() {
  return {
    name: 'workbench-readonly-preview',
    configureServer(server) {
      // Explicit opt-in uses a separate review database and the exact production Rust implementation.
      const reviewEnabled = process.env.DIYTOOLS_REVIEW_BACKEND === '1';
      const reviewDirectory = process.env.DIYTOOLS_REVIEW_DIRECTORY;
      const assetRoot = reviewEnabled && reviewDirectory ? path.join(reviewDirectory, 'workbench-assets') : defaultAssetRoot;
      let host, pending = [], ready;
      if (reviewEnabled) {
        const binary = path.join(project, 'apps/desktop/src-tauri/target/debug/workbench-review-host' + (process.platform === 'win32' ? '.exe' : ''));
        host = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        ready = new Promise((resolve, reject) => { host.once('spawn', resolve); host.once('error', reject); });
        createInterface({ input: host.stdout }).on('line', line => {
          const request = pending.shift();
          if (request) { try { request.resolve(JSON.parse(line)); } catch (e) { request.reject(e); } }
        });
        host.stderr.on('data', data => server.config.logger.error(String(data)));
        host.once('exit', code => { while (pending.length) pending.shift().reject(Error('Review store exited: ' + code)); });
        server.httpServer?.once('close', () => host.kill());
      }
      const callReview = async input => {
        await ready;
        return new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
          host.stdin.write(JSON.stringify(input) + '\n', error => { if (error) reject(error); });
        });
      };
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        // Opt-in local instrumentation; never included in desktop assets.
        if (process.env.DIYTOOLS_PERF_PROBE === '1') {
          if (url.pathname === '/workbench/bootstrap.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end("import '/__workbench_perf_probe.js';\n" + await readFile(path.join(project, 'apps/desktop/public/workbench/bootstrap.js'), 'utf8')); return;
          }
          if (url.pathname === '/__workbench_perf_probe.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(await readFile(path.join(project, 'tools/workbench-performance-probe.js'), 'utf8')); return;
          }
          if (url.pathname === '/workbench/scoped-save.js') {
            let source = await readFile(path.join(project, 'apps/desktop/public/workbench/scoped-save.js'), 'utf8');
            source = source.replace('export function captureSaveSnapshot(', 'function __measured_captureSaveSnapshot(');
            source += `\nexport function captureSaveSnapshot(...args){const start=performance.now();const snapshot=__measured_captureSaveSnapshot(...args);window.workbenchPerfRecord('save:capture:'+(saveSnapshotIds(snapshot)===null?'full':'scoped'),performance.now()-start);return snapshot;}\n`;
            res.setHeader('Content-Type', 'text/javascript');res.end(source);return;
          }
          if (url.pathname === '/workbench/app.js') {
            const file = process.env.DIYTOOLS_PERF_BASELINE === '1' ? 'sandbox/performance-20261012/app-before.js' : 'apps/desktop/public/workbench/app.js';
            let source = await readFile(path.join(project, file), 'utf8');
            for (const name of ['checkpoint', 'checkpointConfig', 'changed']) {
              if (!source.includes('function ' + name + '(')) continue;
              source = source.replace('function ' + name + '(', 'function __measured_' + name + '(');
              source += `\nfunction ${name}(...args){const start=performance.now();try{return __measured_${name}(...args);}finally{window.workbenchPerfRecord('handler:${name}',performance.now()-start);}}\n`;
            }
            res.setHeader('Content-Type', 'text/javascript');res.end(source);return;
          }
        }

        const json = (value, status = 200) => {
          res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
        };
        if (url.pathname.startsWith('/api/')) {
          if (reviewEnabled) {
            if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return json({ error: 'Review origin mismatch' }, 403);
            try {
              let body = null;
              if (!['GET', 'HEAD'].includes(req.method)) {
                if (!req.headers['content-type']?.startsWith('application/json')) return json({ error: 'JSON required' }, 415);
                const chunks = []; let length = 0;
                for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024 ** 2) throw Error('Review request too large'); chunks.push(chunk); }
                body = Buffer.concat(chunks).toString('utf8');
              }
              const result = await callReview({ method: req.method, path: url.pathname + url.search, body });
              res.statusCode = result.status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store'); res.end(result.body);
            } catch (error) { json({ error: String(error) }, 503); }
            return;
          }
          if (req.method !== 'GET') return json({ error: '浏览器仅用于只读页面核验，请在桌面重构版保存修改。' }, 503);
          if (url.pathname === '/api/state') {
            const file = path.join(project, 'sandbox/migration-review/20261011/source-state.json');
            try { await stat(file); res.setHeader('Content-Type', 'application/json; charset=utf-8'); createReadStream(file).pipe(res); }
            catch { json({ error: '本地状态副本不存在，请先完成迁移。' }, 404); }
            return;
          }
          if (url.pathname === '/api/session') return json({ defaultOperator: '本地用户', preview: true });
          if (url.pathname === '/api/derived/status') return json({ productFiles: false, phase: 'ready' });
          return json({ error: '此功能需要桌面本地存储；浏览器预览未连接。' }, 503);
        }
        if (!url.pathname.startsWith('/uploads/') && !url.pathname.startsWith('/saved/')) return next();
        try {
          const rel = decodeURIComponent(url.pathname).slice(1);
          if (rel.includes('\\') || rel.includes(':') || rel.includes('\0') || rel.split('/').some(x => x === '..' || x === '.')) throw Error('invalid path');
          const base = await realpath(assetRoot), file = await realpath(path.join(base, rel));
          if (!file.startsWith(base + path.sep)) throw Error('outside asset root');
          const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file).toLowerCase()];
          if (!mime || (await stat(file)).size > 128 * 1024 ** 2) throw Error('unsupported image');
          res.setHeader('Content-Type', mime); res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(await readFile(file));
        } catch { res.statusCode = 404; res.end('Local asset unavailable'); }
      });
    },
  };
}
