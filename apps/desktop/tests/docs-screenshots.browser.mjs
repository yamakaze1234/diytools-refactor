/** 通过真实 React 宿主和 NAS 编辑器拍摄公开例图，所有业务响应由内存样本提供。 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {blankConfig} from '../public/workbench/core.js';
import {summaryOf} from '../public/workbench/lazy-workspace.js';

const origin = new URL(process.env.REACT_TEST_URL || 'http://127.0.0.1:5230').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/);
const screenshots = process.env.WORKBENCH_SCREENSHOTS ||
  fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
const dependencyFiles = '/@fs/' + new URL('../../../node_modules/', import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/i, '');
const shopIds = ['intel', 'gigabyte', 'jonsbo'];
const updatedAt = '2026-11-26T07:36:00.000Z';
const identity = {uid: 'sample-operator', workspace_id: 'sample-studio', deployment_id: 'sample-nas'};
const settings = {configured: true, main_editor: true, endpoint_id: 'sample-docs', deployment_id: identity.deployment_id};
const shops = shopIds.map(shop_id => ({shop_id, role: 'operations'}));
const shopCapabilities = Object.fromEntries(shopIds.map(shop => [shop, {
  data_source: shop + '_live', workspace_writes: true, configuration_writes: true,
  catalog_writes: true, shared_sources: true, image_upload: true,
}]));
const caseImage = '/assets/docs-sample-case.svg';

// 使用虚构货号、价格、库存、链接和三店名称覆盖。样本无需配置文件或数据库。
const components = [
  ['CPU', 'Core Ultra 5 245KF', '处理器', 1349, 1389, 46, 0],
  ['散热', 'Aero 360 一体式水冷', '散热器', 259, 279, 24, 12],
  ['主板', 'B860M WIFI DDR5', '主板', 729, 759, 35, 0],
  ['内存', 'DDR5 6000 32GB（16GB × 2）', '内存', 449, 479, 62, 0],
  ['硬盘', 'NVMe PCIe 4.0 1TB', '固态硬盘', 339, 359, 54, 0],
  ['显卡', 'GeForce RTX 5060 Ti 16GB', '显卡', 2899, 2969, 18, 8],
  ['电源', '750W 金牌全模组 ATX 3.1', '电源', 319, 339, 31, 0],
  ['机箱', 'Aero M40 全景侧透 · 雾白', '机箱', 229, 249, 22, 0],
  ['风扇', '120mm ARGB 反叶套装', '风扇', 69, 79, 39, 0],
  ['显卡', 'GeForce RTX 5070 12GB', '显卡', 3769, 3849, 7, 10],
  ['硬盘', 'NVMe PCIe 4.0 2TB', '固态硬盘', 609, 639, 14, 7],
  ['内存', 'DDR5 6000 64GB（32GB × 2）', '内存', 879, 919, 0, 16],
].map(([slot, name, erpCategory, erp, tax, stockAvailable, stockIncomingAvailable], i) => ({
  slot, name, erpName: name, goodsId: String(9905701 + i), erpCategory, erp, tax,
  stockAvailable, stockIncomingAvailable, ...(slot === '机箱' ? {erpSpec: '支持 MATX / ITX'} : {}),
}));
const overrides = {
  intel: {0: {tax: 1399}, 5: {tax: 2999}},
  gigabyte: {2: {name: 'B860M WIFI · 装机版', tax: 749}, 6: {tax: 349}},
  jonsbo: {7: {name: 'Aero M40 · 雾白海景房', tax: 269}, 9: {tax: 3899}, 10: {tax: 649}},
};
const costFor = shop => components.map((part, i) => ({...part, ...overrides[shop][i]}));
const sourceId = (shop, goodsId) => 'source-' + shop + '-' + goodsId;
const sourcesFor = shop => costFor(shop).map(part => ({
  ...part, shopId: shop, sourceId: sourceId(shop, part.goodsId),
}));
const sharedSources = components.map((part, i) => ({
  id: part.goodsId,
  version: '1',
  document: {
    id: part.goodsId, erpName: part.erpName, erpCategory: part.erpCategory,
    common: {name: part.name, tax: part.tax},
    stores: Object.fromEntries(shopIds.map(shop => [shop, [{
      sourceId: sourceId(shop, part.goodsId), fields: overrides[shop][i] || {}, legacy: [],
    }]])),
  },
}));
const productLines = [
  ['雾白 M40 · 游戏整机', '游戏整机', [7799, 8099, 8899]],
  ['玄黑 T80 · 高刷游戏', '游戏整机', [7999, 8399, 9199, 9599]],
  ['银翼 S30 · 创作主机', '创作主机', [9499, 9899, 10299, 10799]],
];
const configurations = Object.fromEntries(shopIds.map((shop, shopIndex) => [shop,
  productLines.flatMap(([name, category, prices], linkIndex) => prices.map((price, i) => {
    const spu = '990570000000' + shopIndex + linkIndex;
    const product = {id: shop + '-line-' + linkIndex, name, category, shopId: shop, spu, configs: []};
    const config = blankConfig(null, product, '配置' + (i + 1), '整机装配 · 通电测试 · 理线交付');
    const gpu = (i + linkIndex) % 3 === 2 ? 9 : 5;
    const disk = i === 1 || linkIndex === 2 ? 10 : 4;
    const parts = sourcesFor(shop);
    return {
      ...config, id: product.id + '-' + i, skuId: spu + '0' + (i + 1), workspaceOrder: linkIndex * 10 + i,
      price: price + shopIndex * 100, updatedAt, overviewFeeRate: 3.5,
      shortName: `245KF / ${gpu === 9 ? 'RTX 5070' : '5060 Ti'} / 32G / ${disk === 10 ? '2T' : '1T'}`,
      shortNameAuto: false, version: ['标准版', '进阶版', '旗舰版', '旗舰版 · 扩展'][i], caseImage,
      parts: [0, 1, 2, 3, disk, gpu, 6, 7, 8].map(position => {
        const part = parts[position];
        return {...part, lineId: 'part-' + position, qty: 1, upgrade: ''};
      }),
    };
  })).map(config => ({...config, actualParts: structuredClone(config.parts)})),
]));

// 主机图用几何形状生成，和真实 NAS 一样经图片地址进入原生预览逻辑。
const caseArtwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 392">
  <defs><linearGradient id="glass"><stop stop-color="#29313a"/><stop offset="1" stop-color="#080d14"/></linearGradient></defs>
  <ellipse cx="216" cy="355" rx="158" ry="15" fill="#404954" opacity=".22"/>
  <path fill="#a6b0bd" d="M71 66l196-28 83 47-192 36z"/>
  <path fill="#d1d8df" d="M71 66l87 55v224l-87-58z"/>
  <path fill="#e5e9ed" d="M158 121l192-36v229l-192 31z"/>
  <path fill="url(#glass)" d="M169 131l169-33v197l-169 29z"/>
  <path fill="#141c26" d="M81 83l65 42v196l-65-44z"/>
  <path fill="#4d6070" d="M195 157l72-14v115l-72 15z"/>
  <path stroke="#7a8d9d" stroke-width="4" d="M202 163l54-10m-54 100 54-10m-37-83v88m14-90v88"/>
  <path fill="#202a36" stroke="#607784" d="M177 238l141-26v23l-141 26z"/>
  <path stroke="#8ce6e0" stroke-width="3" d="M185 249l110-20"/>
  <g fill="#192737" stroke="#a9e8ed" stroke-width="3">
    <ellipse cx="308" cy="153" rx="21" ry="23"/><ellipse cx="308" cy="198" rx="21" ry="23"/>
    <ellipse cx="308" cy="267" rx="21" ry="23"/><ellipse cx="111" cy="158" rx="17" ry="23"/>
    <ellipse cx="111" cy="207" rx="17" ry="23"/><ellipse cx="111" cy="256" rx="17" ry="23"/>
  </g>
  <path stroke="#8392a0" stroke-width="2" d="M172 131l68-13-65 89z" opacity=".55"/>
  <path fill="#8b99a8" d="M81 295l13 8v17l-13-9zm80 47l17-3v16l-17 3zm167-26 15-2v13l-15 3z"/>
</svg>`;

const nativeErrors = [];
function invoke(command, args) {
  const response = body => ({status: 200, body: JSON.stringify(body)});
  const result = data => response({ok: true, data});
  if (command === 'plugin:event|listen') return 1;
  if (command === 'plugin:event|unlisten') return null;
  if (command === 'plugin:app|version') return '0.2.57';
  if (command === 'updater_check') return {available: false};
  if (command === 'erp_runtime_check') return {hasLocal: false};
  if (command === 'erp_session_request' && args.input.action === 'match_status') return {job: null};
  if (command === 'agent_ui' && ['ready', 'claim'].includes(args.action)) return null;
  if (command === 'nas_identity_request') {
    return response({session: {configured: true, authenticated: true,
      member: {uid: identity.uid, workspaceId: identity.workspace_id}}});
  }
  if (command === 'nas_erp_read' && ['erp-status', 'tax-status'].includes(args.kind)) {
    return response({ok: true, saved: false, settings: {path: ''}});
  }
  // 来源查用量是查询接口，虽使用 POST，仍只读取内存样本。
  if (command === 'nas_native_request' && args.method === 'POST') {
    const url = new URL(args.route, origin);
    if (url.pathname === '/api/v1/operations/workspace/source-usage') {
      const {sources, goods} = JSON.parse(args.body);
      const rows = configurations[url.searchParams.get('shop_id')];
      return result(rows.filter(config => config.actualParts.some(part =>
        sources.includes(part.sourceId) || goods.includes(part.goodsId))).map(config => config.id));
    }
  }
  if (command === 'nas_native_request' && args.method === 'GET') {
    const url = new URL(args.route, origin);
    const shop = url.searchParams.get('shop_id') || shopIds[0];
    const rows = configurations[shop];
    switch (url.pathname) {
      case '/settings': return response(settings);
      case '/api/v1/me':
        return response({ok: true, ...identity, shops, shop_capabilities: shopCapabilities});
      case '/api/v1/operations/workspace-index':
        return result({revision: shop + '-snapshot', updatedAt,
          summaries: rows.map(config => ({...summaryOf(config), nasVersion: '1'}))});
      case '/api/v1/operations/workspace-catalog':
        return result({sourceCatalog: sourcesFor(shop), costSource: costFor(shop),
          costVersions: Object.fromEntries(components.map(part => [part.goodsId, '1'])),
          shopSettings: {[shop]: {coupon: 100, erpSyncedAt: updatedAt}}, caseGallery: [],
          logs: [], templates: [], addonPacksSupported: true});
      case '/api/v1/operations/catalog/sources':
        return result(sourcesFor(shop).map(document => ({
          id: document.sourceId, document, version: '1', owner_shop: shop, editable: true,
        })));
      case '/api/v1/operations/catalog/shared-sources': return result(sharedSources);
      case '/api/v1/operations/catalog/templates': return result([]);
      case '/api/v1/operations/workspace/activity': return result([{created_at: updatedAt}]);
      default: {
        const id = url.pathname.match(/^\/api\/v1\/operations\/configurations\/([^/]+)$/)?.[1];
        const document = rows?.find(config => config.id === id);
        if (document) return result({id, document, version: '1', dependencies: {sources: {}, costs: {}}});
      }
    }
  }
  const message = `未模拟的原生调用：${command} ${args?.method ?? ''} ${args?.route ?? args?.kind ?? ''}`;
  nativeErrors.push(message);
  throw Error(message);
}

await mkdir(screenshots, {recursive: true});
const errors = [];
const blocked = [];
const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--disable-background-networking']});
try {
  const context = await browser.newContext({
    viewport: {width: 2048, height: 1055}, deviceScaleFactor: 1.25,
    colorScheme: 'light', locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block',
  });
  // 外部请求与本机业务接口一律拦截，只允许 Vite 提供静态资源及模块。
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/workbench' + caseImage) {
      return route.fulfill({contentType: 'image/svg+xml', body: caseArtwork});
    }
    const staticPath = ['/', '/@react-refresh', '/package.json'].includes(url.pathname) ||
      ['/src/', '/workbench/', '/public/workbench/', '/@vite/', '/node_modules/', dependencyFiles]
        .some(prefix => url.pathname.startsWith(prefix));
    if (url.origin === origin && route.request().method() === 'GET' && staticPath) {
      return route.continue();
    }
    blocked.push(url.pathname);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.exposeBinding('invokeScreenshotFixture', (_, command, args) => invoke(command, args));
  await context.addInitScript(screenshotOrigin => {
    // 主题初始化前固定隔离浏览器的偏好，React 宿主与编辑器 iframe 使用同一主题。
    if (location.origin === screenshotOrigin) {
      localStorage.setItem('diytools.workbench.endfield.theme.v1', 'light');
    }
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
    window.__TAURI_INTERNALS__ = {
      metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}},
      transformCallback: () => 1, unregisterCallback() {},
      invoke: (command, args) => window.invokeScreenshotFixture(command, args),
    };
  }, origin);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.setDefaultTimeout(15000);
  await page.goto(origin);
  const frame = page.frameLocator('.legacy-workbench-frame');
  await frame.locator('body.nas-main:not(.login-required)').waitFor();
  await frame.getByRole('button', {name: '退出账号', exact: true}).waitFor();
  await frame.locator('[data-product-toggle="intel-line-0"] .link-arrow').click();
  await frame.locator('.config-item[data-id="intel-line-0-0"]').click();
  await frame.locator('[data-continuous-config="intel-line-0-0"]').waitFor();
  await frame.locator('#poster-object-select option').nth(3).waitFor({state: 'attached'});
  await frame.locator('#poster').waitFor();

  const captures = new Map();
  const capture = async name => {
    const light = 'html[data-workbench-theme="light"]:not(.dark):not([data-workbench-theme-changing])';
    await page.locator(light).waitFor({state: 'attached'});
    await frame.locator(light).waitFor({state: 'attached'});
    await frame.locator('body').evaluate(async body => {
      body.ownerDocument.activeElement?.blur();
      await body.ownerDocument.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.doesNotMatch(await frame.locator('body').innerText(),
      /数据与同步|请登录|已载入本地保存|保存到本机|验收CPU|隔离链接|离线版/);
    await page.mouse.move(0, 0);
    captures.set(name, await page.screenshot({animations: 'disabled'}));
  };

  await capture('workbench-light');

  // 给全屏画布和长表保留更多纵向空间。
  await page.setViewportSize({width: 2048, height: 1140});
  await frame.locator('#preview-expand').click();
  await frame.locator('.canvas-tools > summary').click();
  await frame.getByRole('button', {name: '完整画布', exact: true}).click();
  await frame.locator('#poster-object-select').selectOption({index: 2});
  await frame.locator('#poster-text-content').waitFor();
  await capture('free-editor');
  await frame.locator('#preview-expand').click();

  await frame.getByRole('button', {name: '价格', exact: true}).click();
  await frame.getByRole('heading', {name: '价格与利润', exact: true}).waitFor();
  await frame.locator('[data-pp-row="intel-line-2-3"]').waitFor();
  await capture('price-profit');
  await frame.locator('.pp-menu > summary').click();
  await frame.locator('#pp-back').click();

  await frame.getByRole('button', {name: '维护', exact: true}).click();
  await frame.getByRole('button', {name: '输出源维护', exact: true}).click();
  await frame.getByRole('button', {name: '三店并排', exact: true}).click();
  await frame.locator('[data-filter="different"]').click();
  await page.setViewportSize({width: 2048, height: 1380});
  await frame.locator('[data-sheet-row="9905701"]').waitFor();
  await frame.locator('[data-sheet-row="9905708"]').waitFor();
  assert.ok(await frame.locator('[data-sheet-row]').last().evaluate(row =>
    row.getBoundingClientRect().bottom <= row.closest('.ss-grid').getBoundingClientRect().bottom),
  '输出源例图应完整显示筛选结果');
  await capture('source-maintenance');

  assert.deepEqual(errors, [], '公开截图页面出现脚本错误');
  assert.deepEqual(nativeErrors, [], '公开截图发出了未模拟的原生调用');
  assert.deepEqual(blocked, [], '公开截图发出了业务接口或外部请求');
  for (const [name, bytes] of captures) await writeFile(join(screenshots, name + '.png'), bytes);
  console.log('已生成 4 张浅色 NAS 合成例图，pageerror、未模拟原生调用和外部请求均为 0。');
} catch (error) {
  console.error({errors, nativeErrors, blocked});
  for (const page of browser.contexts()[0]?.pages() ?? []) {
    for (const frame of page.frames()) {
      const text = await frame.locator('body').innerText({timeout: 1000}).catch(() => '');
      console.error(frame.url(), text.slice(0, 500));
    }
  }
  throw error;
} finally {
  await browser.close();
}
